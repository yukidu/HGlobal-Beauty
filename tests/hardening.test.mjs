import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const guard = readFileSync(new URL('../worker/lineSignatureGuard.js', import.meta.url), 'utf8');
const contractWrapper = readFileSync(new URL('../worker/echoContractWrapper.js', import.meta.url), 'utf8');
const wrapper = readFileSync(new URL('../worker/profileSyncWrapper.js', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('../public/bootstrap.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const wrangler = readFileSync(new URL('../wrangler.template.toml', import.meta.url), 'utf8');
const deploy = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');

test('StarBeauty deploys through LINE signature guard, Echo contract adapter, then profile sync wrapper', () => {
  assert.match(wrangler, /main\s*=\s*"worker\/lineSignatureGuard\.js"/);
  assert.match(guard, /import app from '\.\/echoContractWrapper\.js'/);
  assert.match(contractWrapper, /import app from '\.\/profileSyncWrapper\.js'/);
  assert.match(guard, /x-line-signature/);
  assert.match(guard, /HMAC/);
  assert.match(guard, /SHA-256/);
  assert.match(wrapper, /member_profiles/);
  assert.match(wrapper, /profileHash/);
  assert.match(wrapper, /\/api\/profile/);
});

test('web uploads have explicit allowlist, size validation, and R2 post-upload verification', () => {
  assert.match(wrapper, /MAX_UPLOAD_BYTES\s*=\s*2\s*\*\s*1024\s*\*\s*1024\s*\*\s*1024/);
  for (const ext of ['pdf', 'docx', 'xlsx', 'pptx', 'jpg', 'png', 'mp4', 'mov']) {
    assert.ok(wrapper.includes(`'${ext}'`), `${ext} should be explicitly allowed`);
  }
  assert.match(wrapper, /FILES\.head\(row\.objectKey\)/);
  assert.match(wrapper, /actualSize !== declaredSize/);
});

test('state-changing browser APIs reject cross-site origins except signed LINE webhook', () => {
  assert.match(wrapper, /origin && origin !== url\.origin/);
  assert.match(wrapper, /url\.pathname !== '\/api\/line\/webhook'/);
  assert.match(guard, /Invalid signature/);
  assert.match(guard, /LINE 尚未完成設定/);
});

test('frontend normalizes JSON request Content-Type before app code runs', () => {
  assert.match(bootstrap, /Content-Type/);
  assert.match(bootstrap, /application\/json/);
  const bootstrapPos = index.indexOf('/bootstrap.js');
  const appPos = index.indexOf('/app.js');
  assert.ok(bootstrapPos >= 0 && appPos > bootstrapPos, 'bootstrap.js must load before app.js');
});

test('pages explicitly opt out of search indexing', () => {
  assert.match(index, /noindex,nofollow,noarchive,nosnippet,noimageindex/);
  assert.match(wrapper, /X-Robots-Tag/);
});

test('deployment workflow can skip safely until Cloudflare credentials are added', () => {
  assert.match(deploy, /CLOUDFLARE_API_TOKEN/);
  assert.match(deploy, /ready=true/);
  assert.match(deploy, /ready=false/);
});
