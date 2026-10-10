import core from './index.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SUPER_ADMIN_EMAIL = 'yukidu@gmail.com';
const ECHO_DEFAULT = 'https://echostars.yukidu.workers.dev';
const PROFILE_CACHE_TTL_SECONDS = 300;

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
});

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
function cookies(request) {
  const out = {};
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionCookie(token) {
  return `sb_session=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Lax`;
}

async function ensureCoreSchema(request, env) {
  const url = new URL(request.url);
  url.pathname = '/api/health';
  url.search = '';
  await core.fetch(new Request(url.toString(), { method: 'GET' }), env);
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
  const profile = data.profile && typeof data.profile === 'object' ? data.profile : data.user;
  return { user: data.user, profile, profileHash: String(data.profileHash || await sha256(JSON.stringify(profile))), sourceUpdatedAt: String(data.profileUpdatedAt || '') };
}

async function syncProfile(env, payload) {
  const id = String(payload.user.id);
  const email = String(payload.user.email || payload.profile.email || '').trim().toLowerCase();
  if (!email) throw new Error('會員 Email 無效');
  const name = String(payload.profile.name || payload.user.name || email);
  const avatar = String(payload.profile.avatar || payload.user.avatar || '');
  const existing = await env.DB.prepare('SELECT role FROM users WHERE id=? LIMIT 1').bind(id).first();
  const role = email === SUPER_ADMIN_EMAIL ? 'superadmin' : String(existing?.role || 'student');
  const now = Date.now();

  await env.DB.prepare(`
    INSERT INTO users(id,email,name,avatar,role,createdAt,updatedAt)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      email=excluded.email,
      name=excluded.name,
      avatar=excluded.avatar,
      role=CASE WHEN users.role='superadmin' THEN users.role ELSE excluded.role END,
      updatedAt=excluded.updatedAt
  `).bind(id, email, name, avatar, role, now, now).run();

  const previous = await env.DB.prepare('SELECT profileHash FROM member_profiles WHERE userId=? LIMIT 1').bind(id).first();
  const changed = String(previous?.profileHash || '') !== payload.profileHash;
  if (changed) {
    await env.DB.prepare(`
      INSERT INTO member_profiles(userId,profileJson,profileHash,sourceUpdatedAt,syncedAt)
      VALUES(?,?,?,?,?)
      ON CONFLICT(userId) DO UPDATE SET
        profileJson=excluded.profileJson,
        profileHash=excluded.profileHash,
        sourceUpdatedAt=excluded.sourceUpdatedAt,
        syncedAt=excluded.syncedAt
    `).bind(id, JSON.stringify(payload.profile), payload.profileHash, payload.sourceUpdatedAt || null, now).run();
  }

  // Optional KV cache layer. The site does not depend on KV; if a KV binding is added later,
  // profile reads can use it without changing the upper-level API contract.
  if (env.KV) {
    try {
      await env.KV.put(`member-profile:${id}`, JSON.stringify({ profile: payload.profile, profileHash: payload.profileHash, syncedAt: now }), { expirationTtl: PROFILE_CACHE_TTL_SECONDS });
    } catch {}
  }

  return { id, changed, role };
}

async function createSession(env, userId) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expiresAt<=?').bind(now),
    env.DB.prepare('INSERT INTO sessions(tokenHash,userId,expiresAt,createdAt) VALUES(?,?,?,?)').bind(tokenHash, userId, now + SESSION_TTL_MS, now)
  ]);
  return token;
}

async function authCallback(request, env) {
  await ensureCoreSchema(request, env);
  const code = new URL(request.url).searchParams.get('code') || '';
  if (!code) return new Response('缺少登入授權碼', { status: 400 });
  try {
    const payload = await exchangeEchoProfile(code, env);
    const synced = await syncProfile(env, payload);
    const token = await createSession(env, synced.id);
    return new Response(null, {
      status: 302,
      headers: { Location: '/', 'Set-Cookie': sessionCookie(token), 'Cache-Control': 'no-store' }
    });
  } catch (error) {
    return new Response(`登入失敗：${error instanceof Error ? error.message : '未知錯誤'}`, {
      status: 401,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
}

async function currentUserId(request, env) {
  const token = cookies(request).sb_session || '';
  if (!token) return null;
  const row = await env.DB.prepare('SELECT userId,expiresAt FROM sessions WHERE tokenHash=? LIMIT 1').bind(await sha256(token)).first();
  if (!row || Number(row.expiresAt) <= Date.now()) return null;
  return String(row.userId);
}

async function profileApi(request, env) {
  await ensureCoreSchema(request, env);
  const userId = await currentUserId(request, env);
  if (!userId) return json({ error: '請先登入' }, 401);

  if (env.KV) {
    try {
      const cached = await env.KV.get(`member-profile:${userId}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        return json({ ...parsed, source: 'cache' });
      }
    } catch {}
  }

  const row = await env.DB.prepare('SELECT profileJson,profileHash,sourceUpdatedAt,syncedAt FROM member_profiles WHERE userId=? LIMIT 1').bind(userId).first();
  if (!row) return json({ profile: null, profileHash: '', syncedAt: null, source: 'none' });
  const profile = JSON.parse(String(row.profileJson || '{}'));
  if (env.KV) {
    try {
      await env.KV.put(`member-profile:${userId}`, JSON.stringify({ profile, profileHash: row.profileHash, sourceUpdatedAt: row.sourceUpdatedAt, syncedAt: row.syncedAt }), { expirationTtl: PROFILE_CACHE_TTL_SECONDS });
    } catch {}
  }
  return json({ profile, profileHash: row.profileHash, sourceUpdatedAt: row.sourceUpdatedAt, syncedAt: row.syncedAt, source: 'd1' });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/auth/callback' && request.method === 'GET') return authCallback(request, env);
    if (url.pathname === '/api/profile' && request.method === 'GET') return profileApi(request, env);
    return core.fetch(request, env);
  }
};
