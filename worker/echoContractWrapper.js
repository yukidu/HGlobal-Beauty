import app from './profileSyncWrapper.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SUPER_ADMIN_EMAIL = 'yukidu@gmail.com';
const ECHO_DEFAULT = 'https://echostars.yukidu.workers.dev';
const PROFILE_CACHE_TTL_SECONDS = 300;

function base64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function randomToken(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64Url(value);
}
async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function sessionCookie(token) {
  return `sb_session=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Lax`;
}

async function ensureProfileSchema(request, env) {
  const url = new URL(request.url);
  url.pathname = '/api/health';
  url.search = '';
  const health = await app.fetch(new Request(url.toString(), { method: 'GET' }), env);
  if (!health.ok) throw new Error('美力之星資料庫尚未就緒');
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS member_profiles (
      userId TEXT PRIMARY KEY,
      profileJson TEXT NOT NULL,
      profileHash TEXT NOT NULL,
      sourceUpdatedAt TEXT,
      syncedAt INTEGER NOT NULL,
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS member_profiles_hash_idx ON member_profiles(profileHash);
  `);
}

async function exchangeEchoProfile(code, env) {
  const base = String(env.ECHO_BASE_URL || ECHO_DEFAULT).replace(/\/$/, '');
  const response = await fetch(`${base}/api/auth/starbeauty-exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    redirect: 'manual'
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.user?.id) throw new Error(data?.error || '繁星回聲會員驗證失敗');

  const profile = data.profile && typeof data.profile === 'object' ? data.profile : {};
  const contractVersion = String(data.profileContractVersion || profile.profileContractVersion || 'echostars-member-profile-v1');
  const sourceMemberSchemaVersion = String(data.sourceMemberSchemaVersion || profile.sourceMemberSchemaVersion || '');
  const remoteHash = String(data.profileHash || await sha256(JSON.stringify(profile)));
  const storageHash = await sha256(JSON.stringify({ contractVersion, sourceMemberSchemaVersion, remoteHash }));

  return {
    user: data.user,
    profile: {
      ...profile,
      _echoSource: {
        contractVersion,
        memberSchemaVersion: sourceMemberSchemaVersion
      }
    },
    contractVersion,
    sourceMemberSchemaVersion,
    remoteHash,
    storageHash,
    sourceUpdatedAt: String(data.profileUpdatedAt || '')
  };
}

async function syncProfile(env, payload) {
  const id = String(payload.user.id || '');
  const email = String(payload.user.email || payload.profile.email || '').trim().toLowerCase();
  const name = String(payload.user.name || payload.profile.name || email);
  const avatar = String(payload.user.avatar || payload.profile.avatar || '');
  if (!id || !email) throw new Error('繁星回聲會員識別資料不完整');

  const existing = await env.DB.prepare('SELECT id,email,name,avatar,role FROM users WHERE id=? LIMIT 1').bind(id).first();
  const role = email === SUPER_ADMIN_EMAIL ? 'superadmin' : String(existing?.role || 'student');
  const now = Date.now();
  const coreChanged = !existing ||
    String(existing.email || '').trim().toLowerCase() !== email ||
    String(existing.name || '') !== name ||
    String(existing.avatar || '') !== avatar ||
    (email === SUPER_ADMIN_EMAIL && String(existing.role || '') !== 'superadmin');

  if (!existing) {
    await env.DB.prepare('INSERT INTO users(id,email,name,avatar,role,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)')
      .bind(id, email, name, avatar, role, now, now).run();
  } else if (coreChanged) {
    await env.DB.prepare(`
      UPDATE users
      SET email=?,name=?,avatar=?,role=CASE WHEN role='superadmin' THEN role ELSE ? END,updatedAt=?
      WHERE id=?
    `).bind(email, name, avatar, role, now, id).run();
  }

  const previous = await env.DB.prepare('SELECT profileHash FROM member_profiles WHERE userId=? LIMIT 1').bind(id).first();
  const changed = String(previous?.profileHash || '') !== payload.storageHash;
  if (changed) {
    await env.DB.prepare(`
      INSERT INTO member_profiles(userId,profileJson,profileHash,sourceUpdatedAt,syncedAt)
      VALUES(?,?,?,?,?)
      ON CONFLICT(userId) DO UPDATE SET
        profileJson=excluded.profileJson,
        profileHash=excluded.profileHash,
        sourceUpdatedAt=excluded.sourceUpdatedAt,
        syncedAt=excluded.syncedAt
    `).bind(id, JSON.stringify(payload.profile), payload.storageHash, payload.sourceUpdatedAt || null, now).run();

    if (env.KV) {
      try {
        await env.KV.put(
          `member-profile:${id}`,
          JSON.stringify({
            profile: payload.profile,
            profileHash: payload.storageHash,
            sourceUpdatedAt: payload.sourceUpdatedAt,
            syncedAt: now
          }),
          { expirationTtl: PROFILE_CACHE_TTL_SECONDS }
        );
      } catch {}
    }
  }

  return { id, role, changed, coreChanged };
}

async function createSession(env, userId) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expiresAt<=?').bind(now),
    env.DB.prepare('INSERT INTO sessions(tokenHash,userId,expiresAt,createdAt) VALUES(?,?,?,?)')
      .bind(tokenHash, userId, now + SESSION_TTL_MS, now)
  ]);
  return token;
}

async function authCallback(request, env) {
  await ensureProfileSchema(request, env);
  const code = new URL(request.url).searchParams.get('code') || '';
  if (!code) return new Response('缺少登入授權碼', { status: 400 });
  try {
    const payload = await exchangeEchoProfile(code, env);
    const synced = await syncProfile(env, payload);
    const token = await createSession(env, synced.id);
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie': sessionCookie(token),
        'Cache-Control': 'no-store'
      }
    });
  } catch (error) {
    return new Response(`登入失敗：${error instanceof Error ? error.message : '未知錯誤'}`, {
      status: 401,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/auth/callback' && request.method.toUpperCase() === 'GET') {
      return authCallback(request, env);
    }
    return app.fetch(request, env);
  }
};
