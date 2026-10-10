import core from './index.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SUPER_ADMIN_EMAIL = 'yukidu@gmail.com';
const ECHO_DEFAULT = 'https://echostars.yukidu.workers.dev';
const PROFILE_CACHE_TTL_SECONDS = 300;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_LINE_WEBHOOK_BYTES = 1024 * 1024;
const MAX_LINE_EVENTS_PER_WEBHOOK = 50;

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
async function currentStaff(request, env) {
  await ensureCoreSchema(request, env);
  const userId = await currentUserId(request, env);
  if (!userId) return null;
  const user = await env.DB.prepare('SELECT id,email,name,role FROM users WHERE id=? LIMIT 1').bind(userId).first();
  return user && ['teacher', 'admin', 'superadmin'].includes(String(user.role || '')) ? user : null;
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

function lineFileError(message) {
  if (!message || message.type !== 'file') return '';
  const fileName = String(message.fileName || '').trim();
  const extension = fileExtension(fileName);
  const size = Number(message.fileSize || 0);
  if (!fileName || !extension || !ALLOWED_EXTENSIONS.has(extension)) {
    return '這個檔案格式目前不支援。請改用文件、簡報、試算表、圖片、PDF、ZIP 或常見影片格式。';
  }
  if (Number.isFinite(size) && size > MAX_UPLOAD_BYTES) return '單一檔案不可超過 2 GB。';
  return '';
}
async function lineReply(env, replyToken, text) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN || !replyToken) return;
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  }).catch(() => {});
}
async function lineWebhookPreflight(request, env) {
  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > MAX_LINE_WEBHOOK_BYTES) return json({ error: 'Webhook payload too large' }, 413);

  const raw = await request.clone().text();
  if (new TextEncoder().encode(raw).byteLength > MAX_LINE_WEBHOOK_BYTES) return json({ error: 'Webhook payload too large' }, 413);
  let body;
  try { body = JSON.parse(raw || '{}'); }
  catch { return json({ error: 'Webhook JSON 無效' }, 400); }

  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length > MAX_LINE_EVENTS_PER_WEBHOOK) return json({ error: 'Webhook events too many' }, 413);

  for (const event of events) {
    const error = lineFileError(event?.message);
    if (error) {
      await lineReply(env, event?.replyToken, error);
      return json({ success: true, rejected: true, reason: 'unsupported_file' });
    }
  }
  return null;
}

function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
function isoTime(value) {
  const n = Number(value || 0);
  return n > 0 ? new Date(n).toISOString() : '';
}
async function reportOverview(request, env) {
  const staff = await currentStaff(request, env);
  if (!staff) return json({ error: '沒有管理權限' }, 403);

  const [studentsRow, assignmentsResult, statusResult] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role='student'").first(),
    env.DB.prepare(`
      SELECT
        a.id,a.title,a.courseId,a.dueAt,
        CASE
          WHEN a.courseId IS NULL OR NOT EXISTS(SELECT 1 FROM course_members cm0 WHERE cm0.courseId=a.courseId)
          THEN (SELECT COUNT(*) FROM users u WHERE u.role='student')
          ELSE (SELECT COUNT(*) FROM course_members cm JOIN users u ON u.id=cm.userId WHERE cm.courseId=a.courseId AND u.role='student')
        END AS eligibleStudents,
        (SELECT COUNT(*) FROM submissions s
          WHERE s.assignmentId=a.id AND s.status<>'draft'
          AND s.id=(SELECT s2.id FROM submissions s2 WHERE s2.assignmentId=s.assignmentId AND s2.userId=s.userId ORDER BY s2.version DESC,s2.createdAt DESC LIMIT 1)) AS submittedStudents,
        (SELECT COUNT(*) FROM submissions s
          WHERE s.assignmentId=a.id AND s.status='approved'
          AND s.id=(SELECT s2.id FROM submissions s2 WHERE s2.assignmentId=s.assignmentId AND s2.userId=s.userId ORDER BY s2.version DESC,s2.createdAt DESC LIMIT 1)) AS approvedStudents,
        (SELECT COUNT(*) FROM submissions s
          WHERE s.assignmentId=a.id AND s.status='submitted'
          AND s.id=(SELECT s2.id FROM submissions s2 WHERE s2.assignmentId=s.assignmentId AND s2.userId=s.userId ORDER BY s2.version DESC,s2.createdAt DESC LIMIT 1)) AS pendingReview,
        (SELECT COUNT(*) FROM submissions s
          WHERE s.assignmentId=a.id AND s.status='needs_revision'
          AND s.id=(SELECT s2.id FROM submissions s2 WHERE s2.assignmentId=s.assignmentId AND s2.userId=s.userId ORDER BY s2.version DESC,s2.createdAt DESC LIMIT 1)) AS needsRevision,
        (SELECT COUNT(*) FROM submissions s
          WHERE s.assignmentId=a.id AND a.dueAt IS NOT NULL AND s.submittedAt>a.dueAt AND s.status<>'draft'
          AND s.id=(SELECT s2.id FROM submissions s2 WHERE s2.assignmentId=s.assignmentId AND s2.userId=s.userId ORDER BY s2.version DESC,s2.createdAt DESC LIMIT 1)) AS lateStudents
      FROM assignments a
      WHERE a.active=1
      ORDER BY CASE WHEN a.dueAt IS NULL THEN 1 ELSE 0 END,a.dueAt ASC,a.createdAt DESC
    `).all(),
    env.DB.prepare(`
      SELECT s.status,COUNT(*) AS n
      FROM submissions s
      WHERE s.status<>'draft'
        AND s.id=(SELECT s2.id FROM submissions s2 WHERE s2.assignmentId=s.assignmentId AND s2.userId=s.userId ORDER BY s2.version DESC,s2.createdAt DESC LIMIT 1)
      GROUP BY s.status
    `).all()
  ]);

  const assignments = (assignmentsResult.results || []).map(row => {
    const eligible = Number(row.eligibleStudents || 0);
    const submitted = Number(row.submittedStudents || 0);
    return {
      id: row.id,
      title: row.title,
      dueAt: row.dueAt,
      eligibleStudents: eligible,
      submittedStudents: submitted,
      approvedStudents: Number(row.approvedStudents || 0),
      pendingReview: Number(row.pendingReview || 0),
      needsRevision: Number(row.needsRevision || 0),
      lateStudents: Number(row.lateStudents || 0),
      completionRate: eligible > 0 ? Math.round((submitted / eligible) * 1000) / 10 : 0
    };
  });
  const statuses = Object.fromEntries((statusResult.results || []).map(row => [String(row.status), Number(row.n || 0)]));
  return json({
    students: Number(studentsRow?.n || 0),
    activeAssignments: assignments.length,
    pendingReview: Number(statuses.submitted || 0),
    approved: Number(statuses.approved || 0),
    needsRevision: Number(statuses.needs_revision || 0),
    rejected: Number(statuses.rejected || 0),
    assignments
  });
}

async function submissionsCsv(request, env) {
  const staff = await currentStaff(request, env);
  if (!staff) return json({ error: '沒有管理權限' }, 403);
  const { results } = await env.DB.prepare(`
    SELECT s.id,s.version,s.status,s.source,s.submittedAt,s.reviewedAt,s.score,s.feedback,
      s.receiptDate,s.merchant,s.amount,s.invoiceNumber,s.category,
      u.name AS studentName,u.email AS studentEmail,
      a.title AS assignmentTitle,c.title AS courseTitle
    FROM submissions s
    JOIN users u ON u.id=s.userId
    JOIN assignments a ON a.id=s.assignmentId
    LEFT JOIN courses c ON c.id=a.courseId
    WHERE s.status<>'draft'
    ORDER BY COALESCE(s.submittedAt,s.createdAt) DESC
    LIMIT 10000
  `).all();
  const columns = [
    '作業名稱','課程','學員姓名','Email','版本','來源','狀態','繳交時間','審核時間','分數','老師回覆',
    '收據日期','商家','金額','發票號碼','分類','Submission ID'
  ];
  const rows = (results || []).map(row => [
    row.assignmentTitle,row.courseTitle,row.studentName,row.studentEmail,row.version,row.source,row.status,
    isoTime(row.submittedAt),isoTime(row.reviewedAt),row.score,row.feedback,row.receiptDate,row.merchant,row.amount,row.invoiceNumber,row.category,row.id
  ]);
  const csv = '\uFEFF' + [columns, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="starbeauty-submissions-${date}.csv"`,
      'Cache-Control': 'no-store'
    }
  });
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
    if (url.pathname === '/api/admin/reports/overview' && method === 'GET') {
      return withSecurityHeaders(await reportOverview(request, env));
    }
    if (url.pathname === '/api/admin/reports/submissions.csv' && method === 'GET') {
      return withSecurityHeaders(await submissionsCsv(request, env));
    }
    if (url.pathname === '/api/line/webhook' && method === 'POST') {
      const blocked = await lineWebhookPreflight(request, env);
      if (blocked) return withSecurityHeaders(blocked);
      return withSecurityHeaders(await core.fetch(request, env));
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
