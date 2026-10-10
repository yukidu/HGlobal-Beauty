import core from './index.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SUPER_ADMIN_EMAIL = 'yukidu@gmail.com';
const ECHO_DEFAULT = 'https://echostars.yukidu.workers.dev';
const PROFILE_CACHE_TTL_SECONDS = 300;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'txt', 'rtf',
  'odt', 'ods', 'odp', 'pages', 'numbers', 'key', 'zip',
  'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif',
  'mp4', 'mov', 'm4v', 'webm'
]);
const BLOCKED_MIME_TYPES = [
  'text/html', 'application/xhtml+xml', 'image/svg+xml',
  'application/javascript', 'text/javascript', 'application/x-javascript',
  'application/x-msdownload', 'application/x-sh', 'application/x-httpd-php'
];

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
function fileExtension(fileName) {
  const name = String(fileName || '').trim().toLowerCase();
  const index = name.lastIndexOf('.');
  return index > -1 ? name.slice(index + 1) : '';
}
function uploadMetadataError(body) {
  const fileName = String(body?.fileName || '').trim();
  const extension = fileExtension(fileName);
  const size = Number(body?.size);
  const contentType = String(body?.contentType || 'application/octet-stream').split(';')[0].trim().toLowerCase();

  if (!fileName || !extension || !ALLOWED_EXTENSIONS.has(extension)) {
    return '不支援這個檔案格式。可上傳文件、簡報、試算表、圖片、PDF、ZIP 與常見影片格式。';
  }
  if (!Number.isFinite(size) || size <= 0) return '檔案大小無效';
  if (size > MAX_UPLOAD_BYTES) return '單一檔案不可超過 2 GB';
  if (BLOCKED_MIME_TYPES.includes(contentType)) return '此檔案類型基於安全考量無法上傳';
  return '';
}
function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
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
  return {
    user: data.user,
    profile,
    profileHash: String(data.profileHash || await sha256(JSON.stringify(profile))),
    sourceUpdatedAt: String(data.profileUpdatedAt || '')
  };
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

  if (env.KV) {
    try {
      await env.KV.put(
        `member-profile:${id}`,
        JSON.stringify({ profile: payload.profile, profileHash: payload.profileHash, sourceUpdatedAt: payload.sourceUpdatedAt, syncedAt: now }),
        { expirationTtl: PROFILE_CACHE_TTL_SECONDS }
      );
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
      await env.KV.put(
        `member-profile:${userId}`,
        JSON.stringify({ profile, profileHash: row.profileHash, sourceUpdatedAt: row.sourceUpdatedAt, syncedAt: row.syncedAt }),
        { expirationTtl: PROFILE_CACHE_TTL_SECONDS }
      );
    } catch {}
  }
  return json({ profile, profileHash: row.profileHash, sourceUpdatedAt: row.sourceUpdatedAt, syncedAt: row.syncedAt, source: 'd1' });
}

async function uploadStartGuard(request, env) {
  const body = await request.clone().json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: '上傳資料格式錯誤' }, 400);
  const error = uploadMetadataError(body);
  if (error) return json({ error }, 400);

  await ensureCoreSchema(request, env);
  const submissionId = String(body.submissionId || '');
  if (!submissionId) return json({ error: '缺少作業識別碼' }, 400);

  const sub = await env.DB.prepare('SELECT id,userId,assignmentId,status FROM submissions WHERE id=? LIMIT 1').bind(submissionId).first();
  if (!sub || String(sub.status) !== 'draft') return json({ error: '無法上傳到這份作業' }, 403);

  const assignment = await env.DB.prepare('SELECT maxFiles FROM assignments WHERE id=? LIMIT 1').bind(sub.assignmentId).first();
  const completed = await env.DB.prepare('SELECT COUNT(*) AS n FROM submission_files WHERE submissionId=?').bind(submissionId).first();
  const pending = await env.DB.prepare('SELECT COUNT(*) AS n FROM upload_sessions WHERE submissionId=?').bind(submissionId).first();
  const maxFiles = Math.max(1, Number(assignment?.maxFiles || 10));
  if (Number(completed?.n || 0) + Number(pending?.n || 0) >= maxFiles) {
    return json({ error: '檔案數量已達上限' }, 400);
  }
  return null;
}

async function verifyCompletedUpload(env, fileId) {
  const row = await env.DB.prepare('SELECT id,objectKey,size FROM submission_files WHERE id=? LIMIT 1').bind(fileId).first();
  if (!row) return '';
  const object = await env.FILES.head(row.objectKey);
  const actualSize = Number(object?.size || 0);
  const declaredSize = Number(row.size || 0);
  if (actualSize <= 0 || actualSize > MAX_UPLOAD_BYTES || (declaredSize > 0 && actualSize !== declaredSize)) {
    await env.FILES.delete(row.objectKey).catch(() => {});
    await env.DB.prepare('DELETE FROM submission_files WHERE id=?').bind(fileId).run().catch(() => {});
    return actualSize > MAX_UPLOAD_BYTES ? '檔案超過 2 GB 上限' : '檔案大小驗證失敗，請重新上傳';
  }
  return '';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (
      url.pathname.startsWith('/api/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(method) &&
      url.pathname !== '/api/line/webhook'
    ) {
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) {
        return withSecurityHeaders(json({ error: '不允許跨站修改資料' }, 403));
      }
    }

    if (url.pathname === '/auth/callback' && method === 'GET') {
      return withSecurityHeaders(await authCallback(request, env));
    }
    if (url.pathname === '/api/profile' && method === 'GET') {
      return withSecurityHeaders(await profileApi(request, env));
    }
    if (url.pathname === '/api/uploads/start' && method === 'POST') {
      const blocked = await uploadStartGuard(request, env);
      if (blocked) return withSecurityHeaders(blocked);
      return withSecurityHeaders(await core.fetch(request, env));
    }

    const completeMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)\/complete$/);
    if (completeMatch && method === 'POST') {
      const response = await core.fetch(request, env);
      if (!response.ok) return withSecurityHeaders(response);
      const error = await verifyCompletedUpload(env, completeMatch[1]);
      if (error) return withSecurityHeaders(json({ error }, 400));
      return withSecurityHeaders(response);
    }

    return withSecurityHeaders(await core.fetch(request, env));
  }
};
