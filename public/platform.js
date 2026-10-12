const injected=globalThis.__STARB_CONFIG__||{};
export const appConfig=Object.freeze({
  appOrigin:String(injected.appOrigin||location.origin),
  apiBase:String(injected.apiBase||''),
  echoLoginUrl:String(injected.echoLoginUrl||'https://echostars.yukidu.workers.dev/auth/starbeauty'),
  authCallbackPath:String(injected.authCallbackPath||'/auth/callback')
});

const ua=navigator.userAgent||'';
const standalone=Boolean(globalThis.matchMedia?.('(display-mode: standalone)')?.matches||navigator.standalone===true);
export const device=Object.freeze({
  ios:/iPad|iPhone|iPod/.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1),
  android:/Android/i.test(ua),
  standalone,
  web:true
});

let nativeAdapter=null;
export function registerNativePlatform(adapter){nativeAdapter=adapter&&typeof adapter==='object'?adapter:null;}

function apiUrl(path){
  const value=String(path||'');
  if(!appConfig.apiBase)return value;
  return new URL(value,appConfig.apiBase.endsWith('/')?appConfig.apiBase:`${appConfig.apiBase}/`).toString();
}
function fileUrl(fileId){return apiUrl(`/api/files/${encodeURIComponent(String(fileId||''))}`);}
function preparePicker(input,{accept='',multiple=true,capture=''}={}){
  if(!input)return input;
  input.multiple=Boolean(multiple);
  if(accept)input.setAttribute('accept',accept);else input.removeAttribute('accept');
  if(capture)input.setAttribute('capture',capture);else input.removeAttribute('capture');
  return input;
}
async function share(payload){
  if(nativeAdapter?.share)return nativeAdapter.share(payload);
  if(navigator.share){await navigator.share(payload);return true;}
  const text=payload?.url||payload?.text||'';
  if(text&&navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);return true;}
  return false;
}
async function requestNotificationPermission(){
  if(nativeAdapter?.notifications?.requestPermission)return nativeAdapter.notifications.requestPermission();
  if(!('Notification'in globalThis))return 'unsupported';
  return Notification.requestPermission();
}
function beginLogin(){
  if(nativeAdapter?.auth?.beginLogin)return nativeAdapter.auth.beginLogin(appConfig);
  location.assign(appConfig.echoLoginUrl);
}

export const platform=Object.freeze({
  device,
  api:Object.freeze({url:apiUrl}),
  auth:Object.freeze({loginUrl:appConfig.echoLoginUrl,callbackPath:appConfig.authCallbackPath,beginLogin}),
  files:Object.freeze({url:fileUrl,preparePicker,selected:input=>Array.from(input?.files||[])}),
  camera:Object.freeze({prepareInput:(input,options={})=>preparePicker(input,{accept:'image/*',multiple:false,capture:options.capture||'environment'})}),
  notifications:Object.freeze({supported:'Notification'in globalThis,permission:'Notification'in globalThis?Notification.permission:'unsupported',requestPermission:requestNotificationPermission}),
  share
});
