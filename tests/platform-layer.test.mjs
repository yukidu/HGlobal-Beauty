import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const platform=readFileSync(new URL('../public/platform.js',import.meta.url),'utf8');
const index=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));

test('Web production has no Capacitor/Firebase/native dependency cost',()=>{
  const deps={...(pkg.dependencies||{}),...(pkg.devDependencies||{})};
  for(const name of Object.keys(deps)){
    assert.ok(!name.startsWith('@capacitor/'),`unexpected native dependency: ${name}`);
    assert.ok(!name.startsWith('firebase'),`unexpected firebase dependency: ${name}`);
  }
  assert.doesNotMatch(platform,/@capacitor\//);
  assert.doesNotMatch(platform,/firebase/i);
});

test('platform-specific concerns are centralized behind the lightweight platform layer',()=>{
  for(const concern of ['device','auth','files','camera','notifications','share']) assert.ok(platform.includes(concern),`missing platform concern: ${concern}`);
  assert.match(app,/import \{appConfig,platform\} from '\.\/platform\.js'/);
  assert.doesNotMatch(app,/https:\/\/echostars\.yukidu\.workers\.dev/);
});

test('platform detection initializes once without listeners, polling, or render-time recalculation',()=>{
  assert.match(platform,/const ua=navigator\.userAgent/);
  assert.match(platform,/export const device=Object\.freeze/);
  assert.doesNotMatch(platform,/addEventListener/);
  assert.doesNotMatch(platform,/setInterval|setTimeout/);
  assert.doesNotMatch(platform,/fetch\(/);
});

test('current Web APIs remain the default and native support is opt-in only',()=>{
  assert.match(platform,/navigator\.share/);
  assert.match(platform,/navigator\.clipboard/);
  assert.match(platform,/Notification\.requestPermission/);
  assert.match(platform,/registerNativePlatform/);
  assert.match(platform,/if\(nativeAdapter\?/);
});

test('existing Web entry point remains unchanged and no Service Worker behavior is invented',()=>{
  assert.match(index,/script src="\/bootstrap\.js"/);
  assert.match(index,/script type="module" src="\/app\.js"/);
  assert.doesNotMatch(index,/serviceWorker\.register/);
});
