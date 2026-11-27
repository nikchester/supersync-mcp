import test,{mock} from 'node:test';import assert from 'node:assert/strict';
import fs,{mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {parseAccounts} from '../src/accounts.js';import {createSync,networkCause} from '../src/sync.js';
// Runs one refresh against a fetch stub and returns the error code plus the warnings logged.
async function failWith(stub:()=>Promise<Response>){
 const root=mkdtempSync(join(tmpdir(),'sp-sync-errors-'));
 const account=parseAccounts({accounts:[{id:'owner',credentialsPath:join(root,'owner.json'),dataDir:join(root,'owner')}]},root)[0];
 writeFileSync(account.credentialsPath,JSON.stringify({baseUrl:'https://sync.example.org',accessToken:'secret-token',encryptionPassword:'test-password'}),{mode:0o600});
 const originalStat=fs.statSync;
 const statMock=process.platform==='win32'?mock.method(fs,'statSync',((...args:any[])=>{
  const value=(originalStat as any)(...args);return String(args[0]).toLowerCase()===account.credentialsPath.toLowerCase()?Object.assign(Object.create(Object.getPrototypeOf(value)),value,{mode:0o600}):value;
 }) as typeof fs.statSync):undefined;syncBuiltinESMExports();
 const fetchMock=mock.method(globalThis,'fetch',stub as typeof fetch);
 const warnings:string[]=[];const warn=mock.method(console,'warn',(line:string)=>{warnings.push(line);});
 try{
  const sync=createSync(account);
  await sync.warm();
  const error=await sync.current(true).then(()=>undefined,(e:Error)=>e.message);
  return {error,warnings};
 }finally{warn.mock.restore();fetchMock.mock.restore();statMock?.mock.restore();syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});}
}
const connectTimeout=()=>Object.assign(new TypeError('fetch failed'),{cause:Object.assign(new Error('Connect Timeout Error'),{code:'UND_ERR_CONNECT_TIMEOUT'})});
test('an unreachable SuperSync is reported as SUPERSYNC_UNAVAILABLE with the network cause',async()=>{
 const {error,warnings}=await failWith(async()=>{throw connectTimeout();});
 assert.equal(error,'SUPERSYNC_UNAVAILABLE');
 const events=warnings.map(line=>JSON.parse(line));
 assert.ok(events.some(e=>e.event==='supersync_unreachable'&&e.cause==='TypeError UND_ERR_CONNECT_TIMEOUT'));
 assert.ok(events.some(e=>e.event==='warmup_failed'&&e.reason==='SUPERSYNC_UNAVAILABLE'));
 assert.ok(warnings.every(line=>!line.includes('secret-token')&&!line.includes('sync.example.org')));
});
test('a request timeout is reported as SUPERSYNC_UNAVAILABLE',async()=>{
 const {error}=await failWith(async()=>{throw new DOMException('The operation was aborted due to timeout','TimeoutError');});
 assert.equal(error,'SUPERSYNC_UNAVAILABLE');
});
test('a rejected access token is reported as SUPERSYNC_AUTH_REJECTED',async()=>{
 for(const status of [401,403]){
  const {error}=await failWith(async()=>new Response('{}',{status}));
  assert.equal(error,'SUPERSYNC_AUTH_REJECTED');
 }
});
test('a server error is reported as SUPERSYNC_UNAVAILABLE with its status',async()=>{
 const {error,warnings}=await failWith(async()=>new Response('{}',{status:503}));
 assert.equal(error,'SUPERSYNC_UNAVAILABLE');
 assert.ok(warnings.map(line=>JSON.parse(line)).some(e=>e.event==='supersync_unavailable'&&e.status===503));
});
test('networkCause names only the error class and a well-formed code',()=>{
 assert.equal(networkCause(connectTimeout()),'TypeError UND_ERR_CONNECT_TIMEOUT');
 assert.equal(networkCause(Object.assign(new Error('x'),{code:'ECONNREFUSED'})),'Error ECONNREFUSED');
 assert.equal(networkCause(Object.assign(new Error('x'),{code:'https://leak'})),'Error');
 assert.equal(networkCause('nope'),'Error');
});
