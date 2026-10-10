const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const SUPER_ADMIN_EMAIL = 'yukidu@gmail.com';
const ECHO_DEFAULT = 'https://echostars.yukidu.workers.dev';
const MAX_FILE_BYTES = 250 * 1024 * 1024;
const schemaReady = new WeakMap();

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
const now = () => Date.now();
const uid = (p='id') => `${p}_${crypto.randomUUID().replaceAll('-','')}`;
const cleanEmail = v => String(v || '').trim().toLowerCase();
const isStaff = u => ['teacher','admin','superadmin'].includes(String(u?.role || ''));
const isAdmin = u => ['admin','superadmin'].includes(String(u?.role || ''));
const safeName = (v, fallback='file') => (String(v || fallback).replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').replace(/\s+/g,' ').trim() || fallback).slice(0,180);
function base64Url(bytes){ let s=''; for(const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,''); }
function randomToken(n=32){ const a=new Uint8Array(n); crypto.getRandomValues(a); return base64Url(a); }
async function sha256(v){ const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(v))); return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join(''); }
function cookies(req){ const out={}; for(const p of (req.headers.get('Cookie')||'').split(';')){ const i=p.indexOf('='); if(i>0) out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim()); } return out; }
function sessionCookie(token){ return `sb_session=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS/1000)}; HttpOnly; Secure; SameSite=Lax`; }
const clearCookie = () => 'sb_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax';

async function ensureSchema(env){
  if(!env.DB) throw new Error('D1 binding missing');
  if(!schemaReady.has(env.DB)){
    const p=env.DB.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,avatar TEXT DEFAULT '',role TEXT NOT NULL DEFAULT 'student',lineUserId TEXT UNIQUE,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(tokenHash TEXT PRIMARY KEY,userId TEXT NOT NULL,expiresAt INTEGER NOT NULL,createdAt INTEGER NOT NULL,FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(userId);
      CREATE TABLE IF NOT EXISTS courses(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT DEFAULT '',active INTEGER NOT NULL DEFAULT 1,createdBy TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS course_members(courseId TEXT NOT NULL,userId TEXT NOT NULL,createdAt INTEGER NOT NULL,PRIMARY KEY(courseId,userId),FOREIGN KEY(courseId) REFERENCES courses(id) ON DELETE CASCADE,FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS assignments(id TEXT PRIMARY KEY,courseId TEXT,title TEXT NOT NULL,description TEXT DEFAULT '',kind TEXT NOT NULL DEFAULT 'general',openAt INTEGER,dueAt INTEGER,allowLate INTEGER NOT NULL DEFAULT 1,allowResubmit INTEGER NOT NULL DEFAULT 1,maxFiles INTEGER NOT NULL DEFAULT 10,requireReview INTEGER NOT NULL DEFAULT 1,active INTEGER NOT NULL DEFAULT 1,createdBy TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,FOREIGN KEY(courseId) REFERENCES courses(id) ON DELETE SET NULL);
      CREATE INDEX IF NOT EXISTS assignments_course_idx ON assignments(courseId,active);
      CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY,assignmentId TEXT NOT NULL,userId TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',note TEXT DEFAULT '',version INTEGER NOT NULL DEFAULT 1,source TEXT NOT NULL DEFAULT 'web',receiptDate TEXT,merchant TEXT,amount REAL,invoiceNumber TEXT,category TEXT,submittedAt INTEGER,reviewedAt INTEGER,reviewedBy TEXT,score REAL,feedback TEXT DEFAULT '',createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,FOREIGN KEY(assignmentId) REFERENCES assignments(id),FOREIGN KEY(userId) REFERENCES users(id));
      CREATE INDEX IF NOT EXISTS submissions_user_idx ON submissions(userId,createdAt DESC);
      CREATE TABLE IF NOT EXISTS submission_files(id TEXT PRIMARY KEY,submissionId TEXT NOT NULL,userId TEXT NOT NULL,objectKey TEXT NOT NULL UNIQUE,fileName TEXT NOT NULL,contentType TEXT DEFAULT 'application/octet-stream',size INTEGER NOT NULL DEFAULT 0,source TEXT NOT NULL DEFAULT 'web',createdAt INTEGER NOT NULL,FOREIGN KEY(submissionId) REFERENCES submissions(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS upload_sessions(fileId TEXT PRIMARY KEY,submissionId TEXT NOT NULL,userId TEXT NOT NULL,objectKey TEXT NOT NULL UNIQUE,fileName TEXT NOT NULL,contentType TEXT DEFAULT 'application/octet-stream',size INTEGER NOT NULL DEFAULT 0,uploadId TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,userId TEXT NOT NULL,type TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,readAt INTEGER,createdAt INTEGER NOT NULL,FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS audit_logs(id TEXT PRIMARY KEY,actorUserId TEXT,action TEXT NOT NULL,targetType TEXT,targetId TEXT,detail TEXT DEFAULT '',createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS line_link_codes(codeHash TEXT PRIMARY KEY,userId TEXT NOT NULL,expiresAt INTEGER NOT NULL,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS line_inbox(id TEXT PRIMARY KEY,lineUserId TEXT NOT NULL,userId TEXT NOT NULL,objectKey TEXT NOT NULL,fileName TEXT NOT NULL,contentType TEXT DEFAULT 'application/octet-stream',size INTEGER NOT NULL DEFAULT 0,messageId TEXT NOT NULL UNIQUE,createdAt INTEGER NOT NULL,assignedAt INTEGER);
      CREATE TABLE IF NOT EXISTS line_messages(messageId TEXT PRIMARY KEY,processedAt INTEGER NOT NULL);
    `);
    schemaReady.set(env.DB,p); p.catch(()=>schemaReady.delete(env.DB));
  }
  await schemaReady.get(env.DB);
}

async function audit(env, actor, action, type='', target='', detail=''){
  try{ await env.DB.prepare('INSERT INTO audit_logs(id,actorUserId,action,targetType,targetId,detail,createdAt) VALUES(?,?,?,?,?,?,?)').bind(uid('log'),actor||null,action,type||null,target||null,String(detail).slice(0,2000),now()).run(); }catch{}
}
async function notify(env,userId,type,title,body){ await env.DB.prepare('INSERT INTO notifications(id,userId,type,title,body,createdAt) VALUES(?,?,?,?,?,?)').bind(uid('ntf'),userId,type,title,body,now()).run(); }
async function createSession(env,userId){ const token=randomToken(); const h=await sha256(token); const t=now(); await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE expiresAt<=?').bind(t),env.DB.prepare('INSERT INTO sessions(tokenHash,userId,expiresAt,createdAt) VALUES(?,?,?,?)').bind(h,userId,t+SESSION_TTL_MS,t)]); return token; }
async function currentUser(req,env){ await ensureSchema(env); const token=cookies(req).sb_session||''; if(!token) return null; const h=await sha256(token); const row=await env.DB.prepare('SELECT u.*,s.expiresAt AS sessionExpiresAt FROM sessions s JOIN users u ON u.id=s.userId WHERE s.tokenHash=? LIMIT 1').bind(h).first(); if(!row) return null; if(Number(row.sessionExpiresAt)<=now()){ await env.DB.prepare('DELETE FROM sessions WHERE tokenHash=?').bind(h).run().catch(()=>{}); return null; } return row; }
async function requireUser(req,env){ const u=await currentUser(req,env); return u ? {user:u} : {response:json({error:'請先登入'},401)}; }

async function echoExchange(code,env){
  const base=String(env.ECHO_BASE_URL||ECHO_DEFAULT).replace(/\/$/,'');
  const res=await fetch(`${base}/api/auth/starbeauty-exchange`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code}),redirect:'manual'});
  const data=await res.json().catch(()=>({}));
  if(!res.ok || !data?.user?.id) throw new Error(data?.error||'繁星回聲會員驗證失敗');
  return data.user;
}
async function authCallback(req,env){
  await ensureSchema(env); const code=new URL(req.url).searchParams.get('code')||''; if(!code) return new Response('缺少登入授權碼',{status:400});
  try{
    const p=await echoExchange(code,env), email=cleanEmail(p.email), t=now(); if(!email) throw new Error('會員 Email 無效');
    const role=email===SUPER_ADMIN_EMAIL?'superadmin':'student';
    await env.DB.prepare(`INSERT INTO users(id,email,name,avatar,role,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name,avatar=excluded.avatar,updatedAt=excluded.updatedAt`).bind(String(p.id),email,String(p.name||email),String(p.avatar||''),role,t,t).run();
    if(role==='superadmin') await env.DB.prepare('UPDATE users SET role=? WHERE id=?').bind('superadmin',String(p.id)).run();
    const token=await createSession(env,String(p.id)); await audit(env,String(p.id),'login','user',String(p.id),'EchoStars SSO');
    return new Response(null,{status:302,headers:{Location:'/', 'Set-Cookie':sessionCookie(token),'Cache-Control':'no-store'}});
  }catch(e){ return new Response(`登入失敗：${e?.message||'未知錯誤'}`,{status:401,headers:{'Content-Type':'text/plain; charset=utf-8'}}); }
}

async function assignments(env,user){
  const {results}=await env.DB.prepare(`SELECT a.*,c.title AS courseTitle,(SELECT s.status FROM submissions s WHERE s.assignmentId=a.id AND s.userId=? ORDER BY s.version DESC,s.createdAt DESC LIMIT 1) AS myStatus,(SELECT s.id FROM submissions s WHERE s.assignmentId=a.id AND s.userId=? ORDER BY s.version DESC,s.createdAt DESC LIMIT 1) AS mySubmissionId FROM assignments a LEFT JOIN courses c ON c.id=a.courseId WHERE a.active=1 AND (?=1 OR a.courseId IS NULL OR NOT EXISTS(SELECT 1 FROM course_members x WHERE x.courseId=a.courseId) OR EXISTS(SELECT 1 FROM course_members m WHERE m.courseId=a.courseId AND m.userId=?)) ORDER BY CASE WHEN a.dueAt IS NULL THEN 1 ELSE 0 END,a.dueAt,a.createdAt DESC`).bind(user.id,user.id,isStaff(user)?1:0,user.id).all();
  return results||[];
}
async function visibleAssignment(env,user,id){ return (await assignments(env,user)).find(a=>a.id===id)||null; }
async function createSubmission(env,user,b,source='web'){
  const a=await visibleAssignment(env,user,String(b.assignmentId||'')); if(!a) throw new Error('找不到作業或沒有權限'); const t=now();
  if(a.openAt&&t<Number(a.openAt)) throw new Error('作業尚未開放'); if(a.dueAt&&t>Number(a.dueAt)&&!Number(a.allowLate)) throw new Error('作業已截止');
  const prev=await env.DB.prepare('SELECT * FROM submissions WHERE userId=? AND assignmentId=? ORDER BY version DESC,createdAt DESC LIMIT 1').bind(user.id,a.id).first();
  if(prev&&!Number(a.allowResubmit)&&!['needs_revision','rejected'].includes(String(prev.status))) throw new Error('此作業不允許重新繳交');
  const id=uid('sub'), v=prev?Number(prev.version||0)+1:1;
  await env.DB.prepare('INSERT INTO submissions(id,assignmentId,userId,status,note,version,source,receiptDate,merchant,amount,invoiceNumber,category,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,a.id,user.id,'draft',String(b.note||'').slice(0,5000),v,source,b.receiptDate||null,b.merchant||null,b.amount===''||b.amount==null?null:Number(b.amount),b.invoiceNumber||null,b.category||null,t,t).run();
  await audit(env,user.id,'submission.create','submission',id,`assignment=${a.id};source=${source}`); return {id,assignment:a,version:v};
}
async function submitDraft(env,user,id){ const s=await env.DB.prepare('SELECT * FROM submissions WHERE id=?').bind(id).first(); if(!s||s.userId!==user.id||s.status!=='draft') return json({error:'無法送出這份作業'},403); const a=await env.DB.prepare('SELECT * FROM assignments WHERE id=?').bind(s.assignmentId).first(); const n=await env.DB.prepare('SELECT COUNT(*) n FROM submission_files WHERE submissionId=?').bind(id).first(); if(String(a?.kind)!=='text'&&Number(n?.n||0)<1) return json({error:'請至少上傳一個檔案'},400); const t=now(); await env.DB.prepare("UPDATE submissions SET status='submitted',submittedAt=?,updatedAt=? WHERE id=?").bind(t,t,id).run(); await notify(env,user.id,'submitted','作業已繳交',`「${a?.title||'作業'}」已成功送出。`); return json({success:true}); }

async function uploadStart(req,env,user){
  const b=await req.json().catch(()=>({})), s=await env.DB.prepare('SELECT * FROM submissions WHERE id=?').bind(String(b.submissionId||'')).first();
  if(!s||s.userId!==user.id||s.status!=='draft') return json({error:'無法上傳到這份作業'},403);
  const a=await env.DB.prepare('SELECT maxFiles FROM assignments WHERE id=?').bind(s.assignmentId).first(), n=await env.DB.prepare('SELECT COUNT(*) n FROM submission_files WHERE submissionId=?').bind(s.id).first();
  if(Number(n?.n||0)>=Number(a?.maxFiles||10)) return json({error:'檔案數量已達上限'},400);
  const size=Math.max(0,Number(b.size||0)); if(size>MAX_FILE_BYTES) return json({error:'單一檔案上限 250MB'},400);
  const fileId=uid('file'), name=safeName(b.fileName,'upload.bin'), type=String(b.contentType||'application/octet-stream').slice(0,150), key=`submissions/${user.id}/${s.id}/${fileId}-${name}`;
  const mp=await env.FILES.createMultipartUpload(key,{httpMetadata:{contentType:type}});
  await env.DB.prepare('INSERT INTO upload_sessions(fileId,submissionId,userId,objectKey,fileName,contentType,size,uploadId,createdAt) VALUES(?,?,?,?,?,?,?,?,?)').bind(fileId,s.id,user.id,key,name,type,size,mp.uploadId,now()).run();
  return json({fileId,chunkSize:8*1024*1024});
}
async function uploadPart(req,env,user,fileId,partNo){ const r=await env.DB.prepare('SELECT * FROM upload_sessions WHERE fileId=?').bind(fileId).first(); if(!r||r.userId!==user.id||!req.body) return json({error:'上傳工作不存在'},404); const p=await env.FILES.resumeMultipartUpload(r.objectKey,r.uploadId).uploadPart(partNo,req.body); return json({partNumber:p.partNumber,etag:p.etag}); }
async function uploadComplete(req,env,user,fileId){ const r=await env.DB.prepare('SELECT * FROM upload_sessions WHERE fileId=?').bind(fileId).first(); if(!r||r.userId!==user.id) return json({error:'上傳工作不存在'},404); const b=await req.json().catch(()=>({})), parts=Array.isArray(b.parts)?b.parts.map(p=>({partNumber:Number(p.partNumber),etag:String(p.etag)})):[]; if(!parts.length) return json({error:'缺少分段資訊'},400); await env.FILES.resumeMultipartUpload(r.objectKey,r.uploadId).complete(parts); await env.DB.batch([env.DB.prepare('INSERT INTO submission_files(id,submissionId,userId,objectKey,fileName,contentType,size,source,createdAt) VALUES(?,?,?,?,?,?,?,?,?)').bind(r.fileId,r.submissionId,r.userId,r.objectKey,r.fileName,r.contentType,r.size,'web',now()),env.DB.prepare('DELETE FROM upload_sessions WHERE fileId=?').bind(r.fileId)]); return json({success:true,fileId:r.fileId}); }
async function fileResponse(req,env,user,id){ const r=await env.DB.prepare('SELECT f.*,s.userId ownerId FROM submission_files f JOIN submissions s ON s.id=f.submissionId WHERE f.id=?').bind(id).first(); if(!r||(!isStaff(user)&&r.ownerId!==user.id)) return new Response('檔案不存在',{status:404}); const obj=await env.FILES.get(r.objectKey,{range:req.headers}); if(!obj) return new Response('檔案不存在',{status:404}); const h=new Headers(); obj.writeHttpMetadata(h); h.set('ETag',obj.httpEtag); h.set('Cache-Control','private, max-age=60'); h.set('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(r.fileName)}`); return new Response(obj.body,{status:obj.range?206:200,headers:h}); }

async function verifyLine(raw,sig,secret){ if(!sig||!secret) return false; const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']); const out=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(raw))); let s=''; for(const b of out) s+=String.fromCharCode(b); return btoa(s)===sig; }
async function lineReply(env,token,messages){ if(!env.LINE_CHANNEL_ACCESS_TOKEN||!token) return; await fetch('https://api.line.me/v2/bot/message/reply',{method:'POST',headers:{Authorization:`Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({replyToken:token,messages})}); }
async function lineContent(env,id){ return fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(id)}/content`,{headers:{Authorization:`Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`}}); }
async function attachLine(env,user,inbox,assignmentId){ const a=await visibleAssignment(env,user,assignmentId); if(!a) throw new Error('找不到指定作業'); const c=await createSubmission(env,user,{assignmentId},'line'), t=now(); await env.DB.batch([env.DB.prepare('INSERT INTO submission_files(id,submissionId,userId,objectKey,fileName,contentType,size,source,createdAt) VALUES(?,?,?,?,?,?,?,?,?)').bind(uid('file'),c.id,user.id,inbox.objectKey,inbox.fileName,inbox.contentType,inbox.size,'line',t),env.DB.prepare("UPDATE submissions SET status='submitted',submittedAt=?,updatedAt=? WHERE id=?").bind(t,t,c.id),env.DB.prepare('UPDATE line_inbox SET assignedAt=? WHERE id=?').bind(t,inbox.id)]); await notify(env,user.id,'submitted','LINE 作業已繳交',`「${a.title}」已成功送出。`); return a; }
async function lineEvent(env,e){
  const reply=e.replyToken, lineUserId=e.source?.userId||''; if(!lineUserId) return; let user=await env.DB.prepare('SELECT * FROM users WHERE lineUserId=?').bind(lineUserId).first();
  if(e.type==='message'&&e.message?.type==='text'){
    const text=String(e.message.text||'').trim(), m=text.match(/^綁定\s+([A-Z0-9]{6,12})$/i);
    if(m){ const row=await env.DB.prepare('DELETE FROM line_link_codes WHERE codeHash=? AND expiresAt>? RETURNING userId').bind(await sha256(m[1].toUpperCase()),now()).first(); if(!row) return lineReply(env,reply,[{type:'text',text:'綁定碼無效或已過期，請回到美力之星重新產生。'}]); await env.DB.prepare('UPDATE users SET lineUserId=?,updatedAt=? WHERE id=?').bind(lineUserId,now(),row.userId).run(); return lineReply(env,reply,[{type:'text',text:'綁定完成！之後可直接把作業、簡報、照片或影片傳給我。'}]); }
    const pick=text.match(/^#交作業\s+(asg_[A-Za-z0-9]+)\s+(lin_[A-Za-z0-9]+)$/); if(pick&&user){ const box=await env.DB.prepare('SELECT * FROM line_inbox WHERE id=? AND userId=? AND assignedAt IS NULL').bind(pick[2],user.id).first(); if(!box) return lineReply(env,reply,[{type:'text',text:'這個檔案已處理或已過期。'}]); try{ const a=await attachLine(env,user,box,pick[1]); return lineReply(env,reply,[{type:'text',text:`已成功繳交「${a.title}」。`}]); }catch(err){ return lineReply(env,reply,[{type:'text',text:`無法繳交：${err?.message||'請稍後再試'}`}]); } }
    return lineReply(env,reply,[{type:'text',text:user?'你可以直接傳送作業檔案、簡報、照片或影片給我。':'請先到美力之星網站登入，取得 LINE 綁定碼後傳送「綁定 你的代碼」。'}]);
  }
  const msg=e.message; if(e.type!=='message'||!msg||!['file','image','video'].includes(msg.type)) return; if(!user) return lineReply(env,reply,[{type:'text',text:'檔案已收到，但你的 LINE 尚未綁定美力之星。請先完成綁定再傳一次。'}]);
  if(await env.DB.prepare('SELECT 1 ok FROM line_messages WHERE messageId=?').bind(String(msg.id)).first()) return;
  const res=await lineContent(env,String(msg.id)); if(!res.ok||!res.body) return lineReply(env,reply,[{type:'text',text:'檔案讀取失敗，請重新傳送。'}]);
  const name=safeName(msg.fileName||`${msg.type}-${msg.id}${msg.type==='image'?'.jpg':msg.type==='video'?'.mp4':''}`), type=res.headers.get('Content-Type')||(msg.type==='image'?'image/jpeg':msg.type==='video'?'video/mp4':'application/octet-stream'), key=`line/${user.id}/${Date.now()}-${msg.id}-${name}`, inboxId=uid('lin');
  await env.FILES.put(key,res.body,{httpMetadata:{contentType:type}}); const size=Number(res.headers.get('Content-Length')||0); await env.DB.batch([env.DB.prepare('INSERT INTO line_inbox(id,lineUserId,userId,objectKey,fileName,contentType,size,messageId,createdAt) VALUES(?,?,?,?,?,?,?,?,?)').bind(inboxId,lineUserId,user.id,key,name,type,size,String(msg.id),now()),env.DB.prepare('INSERT INTO line_messages(messageId,processedAt) VALUES(?,?)').bind(String(msg.id),now())]);
  const all=(await assignments(env,user)).filter(a=>(!a.openAt||now()>=Number(a.openAt))&&(!a.dueAt||now()<=Number(a.dueAt)||Number(a.allowLate)));
  if(all.length===1){ const a=await attachLine(env,user,await env.DB.prepare('SELECT * FROM line_inbox WHERE id=?').bind(inboxId).first(),all[0].id); return lineReply(env,reply,[{type:'text',text:`已收到 ${name}，並繳交到「${a.title}」。`}]); }
  if(!all.length) return lineReply(env,reply,[{type:'text',text:`已暫存 ${name}，目前沒有可繳交的作業。`}]);
  return lineReply(env,reply,[{type:'text',text:`已收到 ${name}。請選擇要繳交的作業：`,quickReply:{items:all.slice(0,10).map(a=>({type:'action',action:{type:'message',label:String(a.title).slice(0,20),text:`#交作業 ${a.id} ${inboxId}`}}))}}]);
}
async function lineWebhook(req,env){ await ensureSchema(env); if(!env.LINE_CHANNEL_SECRET||!env.LINE_CHANNEL_ACCESS_TOKEN) return json({error:'LINE 尚未完成設定'},503); const raw=await req.text(); if(!await verifyLine(raw,req.headers.get('x-line-signature')||'',env.LINE_CHANNEL_SECRET)) return new Response('Invalid signature',{status:401}); const body=JSON.parse(raw||'{}'); for(const e of body.events||[]) await lineEvent(env,e); return json({success:true}); }

async function api(req,env){
  await ensureSchema(env); const url=new URL(req.url), path=url.pathname, method=req.method.toUpperCase();
  if(path==='/api/health') return json({ok:true,service:'starbeauty',time:new Date().toISOString()});
  if(path==='/api/line/webhook'&&method==='POST') return lineWebhook(req,env);
  if(path==='/api/logout'&&method==='POST'){ const t=cookies(req).sb_session||''; if(t) await env.DB.prepare('DELETE FROM sessions WHERE tokenHash=?').bind(await sha256(t)).run().catch(()=>{}); return json({success:true},200,{'Set-Cookie':clearCookie()}); }
  const auth=await requireUser(req,env); if(auth.response) return auth.response; const user=auth.user;
  if(path==='/api/me'&&method==='GET'){ const n=await env.DB.prepare('SELECT COUNT(*) n FROM notifications WHERE userId=? AND readAt IS NULL').bind(user.id).first(); return json({user:{id:user.id,email:user.email,name:user.name,avatar:user.avatar,role:user.role,lineLinked:Boolean(user.lineUserId)},unreadNotifications:Number(n?.n||0)}); }
  if(path==='/api/assignments'&&method==='GET') return json({assignments:await assignments(env,user)});
  if(path==='/api/submissions'&&method==='GET'){ const {results}=await env.DB.prepare('SELECT s.*,a.title assignmentTitle,a.kind assignmentKind,c.title courseTitle FROM submissions s JOIN assignments a ON a.id=s.assignmentId LEFT JOIN courses c ON c.id=a.courseId WHERE s.userId=? ORDER BY s.createdAt DESC').bind(user.id).all(); for(const s of results||[]){ const f=await env.DB.prepare('SELECT id,fileName,contentType,size,source FROM submission_files WHERE submissionId=? ORDER BY createdAt').bind(s.id).all(); s.files=f.results||[]; } return json({submissions:results||[]}); }
  if(path==='/api/submissions'&&method==='POST'){ try{return json({submission:await createSubmission(env,user,await req.json().catch(()=>({})))})}catch(e){return json({error:e?.message||'無法建立作業'},400)} }
  let m=path.match(/^\/api\/submissions\/([^/]+)\/submit$/); if(m&&method==='POST') return submitDraft(env,user,m[1]);
  if(path==='/api/uploads/start'&&method==='POST') return uploadStart(req,env,user);
  m=path.match(/^\/api\/uploads\/([^/]+)\/parts\/(\d+)$/); if(m&&method==='PUT') return uploadPart(req,env,user,m[1],Number(m[2]));
  m=path.match(/^\/api\/uploads\/([^/]+)\/complete$/); if(m&&method==='POST') return uploadComplete(req,env,user,m[1]);
  m=path.match(/^\/api\/files\/([^/]+)$/); if(m&&method==='GET') return fileResponse(req,env,user,m[1]);
  if(path==='/api/notifications'&&method==='GET'){ const {results}=await env.DB.prepare('SELECT * FROM notifications WHERE userId=? ORDER BY createdAt DESC LIMIT 100').bind(user.id).all(); return json({notifications:results||[]}); }
  if(path==='/api/notifications/read'&&method==='POST'){ await env.DB.prepare('UPDATE notifications SET readAt=COALESCE(readAt,?) WHERE userId=?').bind(now(),user.id).run(); return json({success:true}); }
  if(path==='/api/line/link-code'&&method==='POST'){ const code=randomToken(8).replace(/[^A-Z0-9]/gi,'').toUpperCase().slice(0,8).padEnd(8,'X'), t=now(); await env.DB.batch([env.DB.prepare('DELETE FROM line_link_codes WHERE userId=? OR expiresAt<=?').bind(user.id,t),env.DB.prepare('INSERT INTO line_link_codes(codeHash,userId,expiresAt,createdAt) VALUES(?,?,?,?)').bind(await sha256(code),user.id,t+LINK_CODE_TTL_MS,t)]); return json({code,expiresAt:t+LINK_CODE_TTL_MS,linked:Boolean(user.lineUserId)}); }
  if(path.startsWith('/api/admin/')){
    if(!isStaff(user)) return json({error:'沒有管理權限'},403);
    if(path==='/api/admin/summary'&&method==='GET'){ const [u,a,p,ok,rev]=await Promise.all([env.DB.prepare('SELECT COUNT(*) n FROM users').first(),env.DB.prepare('SELECT COUNT(*) n FROM assignments WHERE active=1').first(),env.DB.prepare("SELECT COUNT(*) n FROM submissions WHERE status='submitted'").first(),env.DB.prepare("SELECT COUNT(*) n FROM submissions WHERE status='approved'").first(),env.DB.prepare("SELECT COUNT(*) n FROM submissions WHERE status='needs_revision'").first()]); return json({users:Number(u?.n||0),assignments:Number(a?.n||0),pending:Number(p?.n||0),approved:Number(ok?.n||0),needsRevision:Number(rev?.n||0)}); }
    if(path==='/api/admin/courses'&&method==='GET'){ const {results}=await env.DB.prepare('SELECT * FROM courses ORDER BY active DESC,createdAt DESC').all(); return json({courses:results||[]}); }
    if(path==='/api/admin/courses'&&method==='POST'){ const b=await req.json().catch(()=>({})), id=uid('crs'),t=now(); await env.DB.prepare('INSERT INTO courses(id,title,description,active,createdBy,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)').bind(id,String(b.title||'未命名課程').slice(0,200),String(b.description||'').slice(0,5000),1,user.id,t,t).run(); return json({id}); }
    if(path==='/api/admin/assignments'&&method==='GET'){ const {results}=await env.DB.prepare('SELECT a.*,c.title courseTitle FROM assignments a LEFT JOIN courses c ON c.id=a.courseId ORDER BY a.createdAt DESC').all(); return json({assignments:results||[]}); }
    if(path==='/api/admin/assignments'&&method==='POST'){ const b=await req.json().catch(()=>({})), id=uid('asg'),t=now(),kind=['general','receipt','presentation','video','text'].includes(b.kind)?b.kind:'general'; await env.DB.prepare('INSERT INTO assignments(id,courseId,title,description,kind,openAt,dueAt,allowLate,allowResubmit,maxFiles,requireReview,active,createdBy,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,b.courseId||null,String(b.title||'未命名作業').slice(0,200),String(b.description||'').slice(0,10000),kind,b.openAt?Number(b.openAt):null,b.dueAt?Number(b.dueAt):null,b.allowLate===false?0:1,b.allowResubmit===false?0:1,Math.max(1,Math.min(30,Number(b.maxFiles||10))),b.requireReview===false?0:1,1,user.id,t,t).run(); return json({id}); }
    if(path==='/api/admin/submissions'&&method==='GET'){ const {results}=await env.DB.prepare("SELECT s.*,a.title assignmentTitle,a.kind assignmentKind,u.name userName,u.email userEmail,c.title courseTitle FROM submissions s JOIN assignments a ON a.id=s.assignmentId JOIN users u ON u.id=s.userId LEFT JOIN courses c ON c.id=a.courseId WHERE s.status<>'draft' ORDER BY COALESCE(s.submittedAt,s.createdAt) DESC LIMIT 500").all(); for(const s of results||[]){ const f=await env.DB.prepare('SELECT id,fileName,contentType,size,source FROM submission_files WHERE submissionId=? ORDER BY createdAt').bind(s.id).all(); s.files=f.results||[]; } return json({submissions:results||[]}); }
    m=path.match(/^\/api\/admin\/submissions\/([^/]+)\/review$/); if(m&&method==='POST'){ const b=await req.json().catch(()=>({})), status=['approved','needs_revision','rejected'].includes(b.status)?b.status:''; if(!status) return json({error:'審核狀態無效'},400); const s=await env.DB.prepare('SELECT * FROM submissions WHERE id=?').bind(m[1]).first(); if(!s) return json({error:'作業不存在'},404); await env.DB.prepare('UPDATE submissions SET status=?,feedback=?,score=?,reviewedAt=?,reviewedBy=?,updatedAt=? WHERE id=?').bind(status,String(b.feedback||'').slice(0,10000),b.score===''||b.score==null?null:Number(b.score),now(),user.id,now(),s.id).run(); const a=await env.DB.prepare('SELECT title FROM assignments WHERE id=?').bind(s.assignmentId).first(); await notify(env,s.userId,'review',status==='approved'?'作業已通過':status==='needs_revision'?'作業需要補件':'作業未通過',`「${a?.title||'作業'}」${b.feedback?`：${String(b.feedback).slice(0,300)}`:''}`); return json({success:true}); }
    if(path==='/api/admin/users'&&method==='GET'){ const {results}=await env.DB.prepare("SELECT u.id,u.email,u.name,u.avatar,u.role,u.lineUserId,u.createdAt,(SELECT COUNT(*) FROM submissions s WHERE s.userId=u.id AND s.status<>'draft') submissionCount FROM users u ORDER BY u.name COLLATE NOCASE").all(); return json({users:results||[]}); }
    m=path.match(/^\/api\/admin\/users\/([^/]+)\/role$/); if(m&&method==='PUT'){ if(!isAdmin(user)) return json({error:'只有管理員可調整角色'},403); const b=await req.json().catch(()=>({})), role=['student','teacher','admin'].includes(b.role)?b.role:''; if(!role) return json({error:'角色無效'},400); const target=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(m[1]).first(); if(!target) return json({error:'會員不存在'},404); if(cleanEmail(target.email)===SUPER_ADMIN_EMAIL) return json({error:'最高管理員角色不可變更'},403); await env.DB.prepare('UPDATE users SET role=?,updatedAt=? WHERE id=?').bind(role,now(),target.id).run(); return json({success:true}); }
  }
  return json({error:'API 不存在'},404);
}

export default { async fetch(request,env){ const u=new URL(request.url); if(u.pathname==='/auth/callback'&&request.method==='GET') return authCallback(request,env); if(u.pathname.startsWith('/api/')) return api(request,env); return env.ASSETS.fetch(request); } };
