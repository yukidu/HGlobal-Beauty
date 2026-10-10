import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const wrapper = readFileSync(new URL('../worker/profileSyncWrapper.js', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('../public/bootstrap.js', import.meta.url), 'utf8');

test('LINE file messages are checked before core webhook processing', () => {
  assert.match(wrapper, /MAX_LINE_WEBHOOK_BYTES/);
  assert.match(wrapper, /MAX_LINE_EVENTS_PER_WEBHOOK/);
  assert.match(wrapper, /function lineFileError/);
  assert.match(wrapper, /message\.fileSize/);
  assert.match(wrapper, /lineWebhookPreflight/);
  assert.match(wrapper, /unsupported_file/);
});

test('LINE image and video messages remain supported while generic files use the allowlist', () => {
  assert.match(wrapper, /message\.type !== 'file'/);
  for (const ext of ['pdf', 'pptx', 'xlsx', 'jpg', 'mp4', 'zip']) {
    assert.ok(wrapper.includes(`'${ext}'`), `${ext} should remain allowed`);
  }
});

test('staff reporting endpoints are authenticated and expose overview plus CSV export', () => {
  assert.match(wrapper, /async function currentStaff/);
  assert.match(wrapper, /\/api\/admin\/reports\/overview/);
  assert.match(wrapper, /\/api\/admin\/reports\/submissions\.csv/);
  assert.match(wrapper, /text\/csv; charset=utf-8/);
  assert.match(wrapper, /LIMIT 10000/);
});

test('CSV export protects spreadsheet users from formula injection', () => {
  assert.match(wrapper, /function csvCell/);
  assert.match(wrapper, /\^\[=\+\\-@\]/);
});

test('admin UI surfaces report summary and CSV download without changing the legacy app bundle', () => {
  assert.match(bootstrap, /starbeautyReportTools/);
  assert.match(bootstrap, /統計與報表/);
  assert.match(bootstrap, /匯出繳交報表 CSV/);
  assert.match(bootstrap, /\/api\/admin\/reports\/overview/);
  assert.match(bootstrap, /MutationObserver/);
});
