import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {bearerMatches} from '../src/auth.js';
import {loadAccessKey,type ServerConfig} from '../src/config.js';
import {parseAccounts} from '../src/accounts.js';
import {createHttpServer,type Runtime} from '../src/http.js';

const KEY='test-access-key-0123456789abcdef';

test('bearer comparison is exact and does not accept a different length',()=>{
 assert.equal(bearerMatches(KEY,KEY),true);
 assert.equal(bearerMatches(KEY+'x',KEY),false);
 assert.equal(bearerMatches('x'.repeat(KEY.length),KEY),false);
 assert.equal(bearerMatches('',KEY),false);
});

test('access key is read from a private file or the environment and rejects a short secret',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-key-')),path=join(dir,'access.key');
 let fixtureMode=0o600;const originalStat=fs.statSync;
 const statMock=process.platform==='win32'?mock.method(fs,'statSync',((...args:any[])=>{
  const value=(originalStat as any)(...args);return args[0]===path?Object.assign(Object.create(Object.getPrototypeOf(value)),value,{mode:fixtureMode}):value;
 }) as typeof fs.statSync):undefined;
 syncBuiltinESMExports();
 try{
  writeFileSync(path,KEY+'\n',{mode:0o600});
  assert.equal(loadAccessKey({},path),KEY);
  assert.throws(()=>loadAccessKey({ACCESS_KEY:'other-access-key-0123456789abcdef'},path),/ACCESS_KEY_MISMATCH/);
  fixtureMode=0o644;chmodSync(path,0o644);assert.throws(()=>loadAccessKey({},path),/ACCESS_KEY_FILE_PERMISSIONS/);
  assert.equal(loadAccessKey({ACCESS_KEY:KEY},join(dir,'missing.key')),KEY);
  assert.throws(()=>loadAccessKey({},join(dir,'missing.key')),/ACCESS_KEY_NOT_CONFIGURED/);
  assert.throws(()=>loadAccessKey({ACCESS_KEY:'too-short'},join(dir,'missing.key')),/ACCESS_KEY_TOO_SHORT/);
 }finally{statMock?.mock.restore();syncBuiltinESMExports();rmSync(dir,{recursive:true,force:true});}
});

function settings(allowWrites:boolean,rateLimitMax=120):ServerConfig{
 return {listenHost:'127.0.0.1',port:1901,allowWrites,allowedHosts:['127.0.0.1','localhost'],rateLimitMax,rateLimitWindowMs:60_000,timeZone:'Europe/Brussels',dayStartHour:4,changeLogPath:'data/changes/changes.jsonl',changeLogMaxBytes:1024*1024,pluginDataPrefixes:[]};
}

async function listen(allowWrites:boolean,rateLimitMax=120){
 let writes=0;
 const root=mkdtempSync(join(tmpdir(),'sp-http-'));
 const account=parseAccounts({accounts:[{id:'owner',credentialsPath:'unused.json',dataDir:'data'}]},root)[0];
 const runtime=(()=>({sync:{current:async()=>{throw new Error('SYNC_CALLED');},invalidate(){}},writer:async()=>{writes++;throw new Error('WRITER_CALLED');}})) as unknown as ()=>Runtime;
 const server=createHttpServer({settings:settings(allowWrites,rateLimitMax),accessKey:KEY,account,runtime});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
 const address=server.address();
 if(!address||typeof address==='string')throw new Error('no port');
 return {server,port:address.port,writes:()=>writes,close:()=>{server.close();rmSync(root,{recursive:true,force:true});}};
}

function post(port:number,body:unknown,headers:Record<string,string>={}){
 return new Promise<{status:number;json:any}>((resolve,reject)=>{
  const payload=JSON.stringify(body);
  const request=httpRequest({
   hostname:'127.0.0.1',port,path:'/mcp',method:'POST',
   headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Host:`127.0.0.1:${port}`,'Content-Length':Buffer.byteLength(payload),...headers},
  },res=>{
   const chunks:Buffer[]=[];res.on('data',(chunk:Buffer)=>chunks.push(chunk));res.on('end',()=>{
    const text=Buffer.concat(chunks).toString('utf8');let json:any;try{json=JSON.parse(text);}catch{json=text;}
    resolve({status:res.statusCode??0,json});
   });
  });
  request.on('error',reject);request.end(payload);
 });
}

const initialize={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}};

test('valid key, wrong key, and missing key are distinct',async()=>{
 const live=await listen(false);
 try{
  const missing=await post(live.port,initialize);
  assert.equal(missing.status,401);
  const wrong=await post(live.port,initialize,{Authorization:'Bearer not-the-access-key-0123456789abcd'});
  assert.equal(wrong.status,401);
  const valid=await post(live.port,initialize,{Authorization:'Bearer '+KEY});
  assert.equal(valid.status,200);
  assert.equal(valid.json.result.serverInfo.name,'super-productivity-mcp');
  const foreign=await post(live.port,initialize,{Authorization:'Bearer '+KEY,Host:'evil.example'});
  assert.equal(foreign.status,403);
 }finally{live.close();}
});

test('read-only mode hides write tools and does not call the writer',async()=>{
 const live=await listen(false);
 try{
  assert.equal((await post(live.port,initialize,{Authorization:'Bearer '+KEY})).status,200);
  const listed=await post(live.port,{jsonrpc:'2.0',id:2,method:'tools/list',params:{}},{Authorization:'Bearer '+KEY});
  assert.equal(listed.status,200);
  const names=listed.json.result.tools.map((tool:{name:string})=>tool.name);
  assert.equal(names.length,15);assert.equal(names.includes('list_habits'),true);assert.equal(names.includes('get_habit'),true);assert.equal(names.includes('set_habit_value'),false);assert.equal(names.includes('search_tasks'),true);assert.equal(names.includes('list_today'),true);assert.equal(names.includes('get_task_time'),true);assert.equal(names.includes('time_by_day'),true);assert.equal(names.includes('worklog_report'),true);assert.equal(names.includes('list_changes'),true);
  assert.equal(names.includes('create_task'),false);
  assert.equal(listed.json.result.tools.every((tool:{annotations?:{readOnlyHint?:boolean}})=>tool.annotations?.readOnlyHint),true);
  const called=await post(live.port,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'create_task',arguments:{requestId:'req-1',expectedServerSeq:0,projectId:'p',title:'nope'}}},{Authorization:'Bearer '+KEY});
  assert.equal(live.writes(),0);
  assert.equal(JSON.stringify(called.json).includes('WRITER_CALLED'),false);
 }finally{live.close();}
});

test('write tools are callable only when the opt-in flag is set',async()=>{
 const live=await listen(true);
 try{
  assert.equal((await post(live.port,initialize,{Authorization:'Bearer '+KEY})).status,200);
  const listed=await post(live.port,{jsonrpc:'2.0',id:2,method:'tools/list',params:{}},{Authorization:'Bearer '+KEY});
  const names=listed.json.result.tools.map((tool:{name:string})=>tool.name);
  assert.equal(names.length,45);for(const name of ['list_habits','get_habit','set_habit_value','set_habit_values','increment_habit','toggle_habit_day','create_habit','update_habit','delete_habit'])assert.equal(names.includes(name),true,name);assert.equal(names.includes('search_tasks'),true);assert.equal(names.includes('list_today'),true);assert.equal(names.includes('time_by_day'),true);assert.equal(names.includes('worklog_report'),true);assert.equal(names.includes('delete_task'),true);assert.equal(names.includes('archive_done_tasks'),true);assert.equal(names.includes('move_task'),true);assert.equal(names.includes('batch'),true);assert.equal(names.includes('list_changes'),true);assert.equal(names.includes('undo_change'),true);
  assert.equal(names.includes('create_task'),true);
  assert.equal(names.includes('create_subtask'),true);
  assert.equal(names.includes('reorder_subtask'),true);
  assert.equal(names.includes('detach_subtask'),true);
  assert.equal(names.includes('attach_task'),true);
  assert.equal(names.includes('get_task_time'),true);
  assert.equal(names.includes('log_task_time'),true);assert.equal(names.includes('set_task_time'),true);
  assert.equal(names.includes('set_task_estimate'),true);
  assert.equal(names.includes('create_tag'),true);
  assert.equal(names.includes('rename_tag'),true);
  await post(live.port,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'create_task',arguments:{requestId:'req-1',expectedServerSeq:0,projectId:'p',title:'hello'}}},{Authorization:'Bearer '+KEY});
  assert.equal(live.writes(),1);
 }finally{live.close();}
});

test('repeated callers are rate limited',async()=>{
 const live=await listen(false,2);
 try{
  assert.equal((await post(live.port,initialize)).status,401);
  assert.equal((await post(live.port,initialize)).status,401);
  const limited=await post(live.port,initialize,{Authorization:'Bearer '+KEY});
  assert.equal(limited.status,429);
  assert.equal(limited.json.error,'rate_limited');
 }finally{live.close();}
});
