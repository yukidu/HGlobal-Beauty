import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const wrapper = readFileSync(new URL('../worker/echoContractWrapper.js', import.meta.url), 'utf8');
const lineGuard = readFileSync(new URL('../worker/lineSignatureGuard.js', import.meta.url), 'utf8');
const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8');

test('StarBeauty reaches EchoStars only through the versioned HTTP exchange contract', () => {
  assert.match(wrapper, /\/api\/auth\/starbeauty-exchange/);
  assert.doesNotMatch(wrapper, /echoes_db/);
  assert.doesNotMatch(wrapper, /organization_groups|upline_bindings/);
  assert.match(wrapper, /profileContractVersion/);
  assert.match(wrapper, /sourceMemberSchemaVersion/);
});

test('Echo profile remains opaque while core identity comes from the stable user envelope', () => {
  assert.match(wrapper, /payload\.user\.email/);
  assert.match(wrapper, /payload\.user\.name/);
  assert.match(wrapper, /payload\.user\.avatar/);
  assert.match(wrapper, /_echoSource/);
  assert.match(wrapper, /contractVersion/);
  assert.match(wrapper, /memberSchemaVersion/);
});

test('contract/schema changes trigger a profile refresh without high-frequency duplicate writes', () => {
  assert.match(wrapper, /storageHash/);
  assert.match(wrapper, /contractVersion, sourceMemberSchemaVersion, remoteHash/);
  assert.match(wrapper, /else if \(coreChanged\)/);
  assert.match(wrapper, /if \(changed\) \{/);
  assert.match(wrapper, /KV\.put/);
});

test('the deployed wrapper chain routes auth through the Echo contract compatibility layer', () => {
  assert.match(lineGuard, /\.\/echoContractWrapper\.js/);
  assert.match(wrapper, /url\.pathname === '\/auth\/callback'/);
  assert.match(pkg, /worker\/echoContractWrapper\.js/);
});
