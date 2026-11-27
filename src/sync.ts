import {loadCredentials} from './config.js';
import {openStore,readLimitedJson,validatePage,storePage} from './ingest.js';
import {project,projectIncremental,type Projection} from './projection.js';import {mkdirSync} from 'node:fs';
import {openAccountStore,type Account} from './accounts.js';
import {mergeVectorClocks} from '@sp/sync-core';
// Names why fetch() failed without echoing the URL or headers: the error name and the
// Node/undici code, such as TimeoutError, UND_ERR_CONNECT_TIMEOUT or ECONNREFUSED.
export function networkCause(e:unknown){
 const name=e instanceof Error?e.name:'Error';
 const code=(e as {cause?:{code?:unknown}})?.cause?.code??(e as {code?:unknown})?.code;
 return typeof code==='string'&&/^[A-Z0-9_]+$/.test(code)?name+' '+code:name;
}
export function createSync(account?:Account){
let pending:Promise<Projection>|undefined;
let last:Projection|undefined;let at=0;
// Projection of the stored log. It survives invalidate(), so a refresh replays
// only the operations downloaded since, not the whole log.
let base:Projection|undefined;
async function download(db:ReturnType<typeof openStore>,cfg:ReturnType<typeof loadCredentials>,from?:Projection){
 let cursor=Number(db.prepare("SELECT value FROM metadata WHERE key='downloadCursor'").get()?.value??0);
 for(let n=0;n<100;n++){
  const url=new URL('/api/sync/ops',cfg.baseUrl);url.searchParams.set('sinceSeq',String(cursor));url.searchParams.set('limit','100');
  let response:Response;
  try{response=await fetch(url,{headers:{Authorization:'Bearer '+cfg.accessToken},redirect:'error',signal:AbortSignal.timeout(30000)});}
  catch(e){console.warn(JSON.stringify({event:'supersync_unreachable',cause:networkCause(e)}));throw new Error('SUPERSYNC_UNAVAILABLE');}
  if(response.status===401||response.status===403)throw new Error('SUPERSYNC_AUTH_REJECTED');
  if(!response.ok){console.warn(JSON.stringify({event:'supersync_unavailable',status:response.status}));throw new Error('SUPERSYNC_UNAVAILABLE');}
  const {page}=await validatePage(await readLimitedJson(response),cfg.encryptionPassword);storePage(db,page);
  if(page.snapshotVectorClock){
   const previous=JSON.parse(String(db.prepare("SELECT value FROM metadata WHERE key='snapshotClock'").get()?.value??'{}'));
   const clock=mergeVectorClocks(previous,page.snapshotVectorClock);
   db.prepare("INSERT INTO metadata(key,value) VALUES('snapshotClock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(clock));
  }
  if(!page.hasMore){
   const started=Date.now();
   const result=from?await projectIncremental(db,cfg.encryptionPassword,from):{...await project(db,cfg.encryptionPassword),mode:'full' as const};
   if(result.mode==='full')console.info(JSON.stringify({event:'projection_full',serverSeq:result.serverSeq,ms:Date.now()-started}));
   if(result.serverSeq!==page.latestSeq)throw new Error('PROJECTION_NOT_CURRENT');
   return {state:result.state,serverSeq:result.serverSeq,clock:result.clock};
  }
  const next=page.ops.at(-1)?.serverSeq;if(!next||next<=cursor)throw new Error('SYNC_NO_PROGRESS');cursor=next;
 }
 throw new Error('SYNC_LIMIT');
}
function withSnapshotClock(db:ReturnType<typeof openStore>,result:Projection){
 const snapshotClock=JSON.parse(String(db.prepare("SELECT value FROM metadata WHERE key='snapshotClock'").get()?.value??'{}'));
 return {...result,clock:mergeVectorClocks(result.clock,snapshotClock)};
}
async function refresh(){
 const cfg=loadCredentials(account?.credentialsPath);const db=account?openAccountStore(account):(mkdirSync('data',{recursive:true,mode:0o700}),openStore('data/operations.sqlite'));
 try{
  try{base=await download(db,cfg,base);return withSnapshotClock(db,base);}catch(e){
   if(!(e instanceof Error)||!['PROJECTION_LOG_GAP','PROJECTION_SNAPSHOT_REQUIRED','PROJECTION_NOT_CURRENT'].includes(e.message))throw e;
   base=undefined;
   // A clean download is validated and projected before replacing only the
   // encrypted read cache. Durable write identities and the outbox survive.
   const candidate=openStore(':memory:');
   try{const result=await download(candidate,cfg);replaceDownloadedCache(db,candidate);base=result;return withSnapshotClock(db,result);}finally{candidate.close();}
  }
 }finally{db.close();}
}
function invalidate(){last=undefined;at=0;}
async function current(force=false){
 if(force){if(pending)await pending;invalidate();}
 if(last&&Date.now()-at<15000)return last;
 if(!pending)pending=refresh().then(v=>{last=v;at=Date.now();return v;}).finally(()=>{pending=undefined;});
 return pending;
}
// Builds the projection at startup so the first tool call does not pay for the full replay.
async function warm(){
 const started=Date.now();
 try{const p=await current();console.info(JSON.stringify({event:'warmup_done',serverSeq:p.serverSeq,ms:Date.now()-started}));}
 catch(e){const reason=e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'SYNC_FAILED';console.warn(JSON.stringify({event:'warmup_failed',reason}));}
}

return {current,invalidate,warm};
}
export function replaceDownloadedCache(db:ReturnType<typeof openStore>,candidate:ReturnType<typeof openStore>){
 db.exec('BEGIN IMMEDIATE');
 try{
  db.exec('DELETE FROM operations');
  const insert=db.prepare('INSERT INTO operations(seq,id,wire) VALUES(?,?,?)');
  for(const row of candidate.prepare('SELECT seq,id,wire FROM operations ORDER BY seq').all())insert.run(row.seq,row.id,row.wire);
  for(const key of ['downloadCursor','snapshotClock']){
   const value=candidate.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;
   db.prepare('DELETE FROM metadata WHERE key=?').run(key);
   if(value!==undefined)db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(key,value);
  }
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
}

const legacySync=createSync();
export const current=legacySync.current,invalidate=legacySync.invalidate;
