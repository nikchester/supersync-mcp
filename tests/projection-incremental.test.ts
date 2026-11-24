import test,{mock} from 'node:test';import assert from 'node:assert/strict';
import fs,{mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {encrypt} from '@sp/sync-core';import {openStore,storePage} from '../src/ingest.js';import {project,projectIncremental} from '../src/projection.js';
import {parseAccounts} from '../src/accounts.js';import {createSync} from '../src/sync.js';
const fixture=()=>JSON.parse(readFileSync('vendor-source/src/app/op-log/validation/test-fixtures/frozen-state-v18.15.json','utf8')).state;
async function wireOp(seq:number,actionType:string,opType:string,entityType:string,payload:unknown,password='test-password'){
 return {serverSeq:seq,receivedAt:1750000000000,op:{id:'01985bc0-0000-7000-8000-'+String(seq).padStart(12,'0'),actionType,opType,entityType,payload:await encrypt(JSON.stringify(payload),password),isPayloadEncrypted:true,clientId:'fixture',vectorClock:{fixture:seq},timestamp:1750000000000+seq,schemaVersion:4}};
}
const addTask=(template:any,id:string,title:string)=>({actionPayload:{task:{...structuredClone(template),id,parentId:undefined,subTaskIds:[],title,isDone:false},isAddToBottom:true,isAddToBacklog:false},entityChanges:[]});
test('incremental projection matches a full replay and does not modify its base',async()=>{
 // Reducers stamp modified with the wall clock, so two full replays differ without a fixed clock.
 const clock=mock.method(Date,'now',()=>1795000000000);
 const db=openStore(':memory:');let seq=0;
 const add=async(...args:[string,string,string,unknown])=>{seq++;storePage(db,{ops:[await wireOp(seq,...args)],hasMore:false,latestSeq:seq});};
 await add('[SP_ALL] Load(import) all data','SYNC_IMPORT','ALL',fixture());
 let base=await project(db,'test-password');const id=base.state.tasks.ids[0];const template=base.state.tasks.entities[id];
 const steps:[string,string,string,unknown][]=[
  ['[Task Shared] addTask','CRT','TASK',addTask(template,'incremental-a','first')],
  ['[Task Shared] updateTask','UPD','TASK',{actionPayload:{task:{id,changes:{isDone:true,title:'done incrementally'}}},entityChanges:[]}],
  ['[Task Shared] addTask','CRT','TASK',addTask(template,'incremental-b','second')],
 ];
 for(const step of steps){
  await add(...step);
  const before=structuredClone(base);
  const next=await projectIncremental(db,'test-password',base);
  assert.equal(next.mode,'incremental');assert.equal(next.applied,1);
  assert.deepEqual(base,before);
  const full=await project(db,'test-password');
  assert.deepEqual({state:next.state,serverSeq:next.serverSeq,clock:next.clock},full);
  base=next;
 }
 // Two operations at once, then nothing new.
 await add('[Task Shared] addTask','CRT','TASK',addTask(template,'incremental-c','third'));
 await add('[Task Shared] addTask','CRT','TASK',addTask(template,'incremental-d','fourth'));
 const two=await projectIncremental(db,'test-password',base);
 assert.equal(two.mode,'incremental');assert.equal(two.applied,2);assert.equal(two.state.tasks.entities['incremental-d'].title,'fourth');
 assert.deepEqual({state:two.state,serverSeq:two.serverSeq,clock:two.clock},await project(db,'test-password'));
 const same=await projectIncremental(db,'test-password',two);
 assert.equal(same.applied,0);assert.equal(same.state,two.state);assert.equal(same.serverSeq,seq);
 // A full-state operation replays the whole log.
 const replacement=fixture();replacement.task.entities[replacement.task.ids[0]].title='after import';
 await add('[SP_ALL] Load(import) all data','SYNC_IMPORT','ALL',replacement);
 const imported=await projectIncremental(db,'test-password',two);
 assert.equal(imported.mode,'full');assert.equal(imported.state.tasks.entities[id].title,'after import');
 assert.equal(imported.state.tasks.entities['incremental-a'],undefined);
 assert.deepEqual({state:imported.state,serverSeq:imported.serverSeq,clock:imported.clock},await project(db,'test-password'));
 // Unknown operations still block reads.
 await add('[Unknown] mutation','UPD','TASK',{actionPayload:{},entityChanges:[]});
 await assert.rejects(projectIncremental(db,'test-password',imported),/PROJECTION_ACTION_UNSUPPORTED/);
 db.close();clock.mock.restore();
});
test('a gap after the base falls back to a full replay, which reports the gap',async()=>{
 const db=openStore(':memory:');
 storePage(db,{ops:[await wireOp(1,'[SP_ALL] Load(import) all data','SYNC_IMPORT','ALL',fixture())],hasMore:false,latestSeq:1});
 const base=await project(db,'test-password');const template=base.state.tasks.entities[base.state.tasks.ids[0]];
 storePage(db,{ops:[await wireOp(3,'[Task Shared] addTask','CRT','TASK',addTask(template,'after-gap','gap'))],hasMore:false,latestSeq:3});
 await assert.rejects(projectIncremental(db,'test-password',base),/PROJECTION_LOG_GAP/);
 db.close();
});
test('sync keeps the projection across refreshes, writes and warm-up, and replays fully only for a snapshot',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sp-incremental-'));
 const account=parseAccounts({accounts:[{id:'owner',credentialsPath:join(root,'owner.json'),dataDir:join(root,'owner')}]},root)[0];
 writeFileSync(account.credentialsPath,JSON.stringify({baseUrl:'https://sync.example.org',accessToken:'token',encryptionPassword:'test-password'}),{mode:0o600});
 const log:any[]=[await wireOp(1,'[SP_ALL] Load(import) all data','SYNC_IMPORT','ALL',fixture())];
 const originalStat=fs.statSync;
 const statMock=process.platform==='win32'?mock.method(fs,'statSync',((...args:any[])=>{
  const value=(originalStat as any)(...args);return String(args[0]).toLowerCase()===account.credentialsPath.toLowerCase()?Object.assign(Object.create(Object.getPrototypeOf(value)),value,{mode:0o600}):value;
 }) as typeof fs.statSync):undefined;syncBuiltinESMExports();
 const fetchMock=mock.method(globalThis,'fetch',(async(url:any)=>{
  const since=Number(new URL(String(url)).searchParams.get('sinceSeq'));
  return new Response(JSON.stringify({hasMore:false,latestSeq:log.length,ops:log.filter(item=>item.serverSeq>since)}));
 }) as typeof fetch);
 const full:any[]=[];const info=mock.method(console,'info',(line:string)=>{const event=JSON.parse(line);if(event.event==='projection_full')full.push(event);});
 try{
  const sync=createSync(account);
  await sync.warm();assert.equal(full.length,1);
  const first=await sync.current();assert.equal(first.serverSeq,1);
  const template=first.state.tasks.entities[first.state.tasks.ids[0]];
  log.push(await wireOp(2,'[Task Shared] addTask','CRT','TASK',addTask(template,'synced-a','from phone')));
  sync.invalidate();
  const second=await sync.current();
  assert.equal(second.serverSeq,2);assert.equal(second.state.tasks.entities['synced-a'].title,'from phone');assert.equal(full.length,1);
  log.push(await wireOp(3,'[Task Shared] addTask','CRT','TASK',addTask(template,'synced-b','from desktop')));
  const forced=await sync.current(true);
  assert.equal(forced.serverSeq,3);assert.ok(forced.state.tasks.entities['synced-b']);assert.equal(full.length,1);
  const replacement=fixture();replacement.task.entities[replacement.task.ids[0]].title='restored backup';
  log.push(await wireOp(4,'[SP_ALL] Load(import) all data','BACKUP_IMPORT','ALL',replacement));
  const restored=await sync.current(true);
  assert.equal(restored.serverSeq,4);assert.equal(restored.state.tasks.entities['synced-b'],undefined);assert.equal(full.length,2);
  log.push(await wireOp(5,'[Task Shared] addTask','CRT','TASK',addTask(template,'synced-c','after restore')));
  const after=await sync.current(true);assert.ok(after.state.tasks.entities['synced-c']);assert.equal(full.length,2);
  // A fresh process starts from the stored log once, then continues incrementally.
  const restarted=createSync(account);await restarted.warm();assert.equal(full.length,3);
  assert.deepEqual((await restarted.current()).state,after.state);
 }finally{info.mock.restore();fetchMock.mock.restore();statMock?.mock.restore();syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});}
});
