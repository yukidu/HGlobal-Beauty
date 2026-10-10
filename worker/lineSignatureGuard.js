import app from './echoContractWrapper.js';

async function verifyLineSignature(raw, signature, secret) {
  if (!raw || !signature || !secret) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw))
  );
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary) === signature;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/line/webhook' && request.method.toUpperCase() === 'POST') {
      if (!env.LINE_CHANNEL_SECRET) {
        return new Response(JSON.stringify({ error: 'LINE 尚未完成設定' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
        });
      }
      const raw = await request.clone().text();
      const signature = request.headers.get('x-line-signature') || '';
      if (!await verifyLineSignature(raw, signature, env.LINE_CHANNEL_SECRET)) {
        return new Response('Invalid signature', {
          status: 401,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
        });
      }
    }
    return app.fetch(request, env);
  }
};
