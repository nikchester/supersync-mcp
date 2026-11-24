import {dateState} from './dates.js';
import {compareVectorClocks,mergeVectorClocks} from '@sp/sync-core';
import {validatePage} from './ingest.js';
import {applyArchive,emptyArchive} from './archive.js';
import type {DatabaseSync} from 'node:sqlite';
export async function officialModule(){(globalThis as any).window??={};const path='../dist/official.mjs';return import(path);}
export type Projection={state:any;serverSeq:number;clock:Record<string,number>};
const FULL_STATE_OPS=['SYNC_IMPORT','BACKUP_IMPORT','REPAIR'];
async function decodeRows(rows:Iterable<Record<string,unknown>>,password:string){
 const all=[];
 for(const row of rows){
  const wire=JSON.parse(String(row.wire));
  const {decoded}=await validatePage({ops:[wire],hasMore:false,latestSeq:wire.serverSeq},password);all.push(decoded[0]);
 }
 return all;
}
function replay(official:any,all:any[],base?:Projection):Projection{
 let state=base?.state,clock:Record<string,number>={...base?.clock},serverSeq=base?.serverSeq??0,initialized=base!==undefined;
 // The server fast-forwards downloads to its latest causally accepted full-state operation.
 for(const {op,serverSeq:seq} of all){
  const full=FULL_STATE_OPS.includes(op.opType);
  if(full){
   if(initialized&&op.opType==='REPAIR'&&(op.repairBaseServerSeq??-1)<serverSeq&&!['GREATER_THAN','EQUAL'].includes(compareVectorClocks(op.vectorClock,clock)))throw new Error('PROJECTION_CONFLICT_UNSUPPORTED');
   const action=official.convertOpToAction(op);
   const snapshot=action.appDataComplete;
   const archives:any={};
   for(const key of ['archiveYoung','archiveOld']){
    const incoming=snapshot[key];
    archives[key]=incoming===undefined?state?.[key]??emptyArchive():op.opType!=='BACKUP_IMPORT'&&state?.[key]?.task?.ids?.length&&!incoming?.task?.ids?.length?state[key]:incoming;
   }
   state={...official.reduce(undefined,action),...archives};
   initialized=true;clock={...op.vectorClock};serverSeq=seq;continue;
  }
  if(!initialized)throw new Error('PROJECTION_SNAPSHOT_REQUIRED');
  if(seq!==serverSeq+1)throw new Error('PROJECTION_LOG_GAP');
  // Operations accepted by SuperSync are ordered by server sequence. A global
  // vector comparison incorrectly rejects valid concurrent edits to different entities.
  if(!official.KNOWN_ACTION_TYPES.has(op.actionType)&&!official.isLwwUpdateActionType(op.actionType))throw new Error('PROJECTION_ACTION_UNSUPPORTED');
  const action=official.convertOpToAction(op);
  const archives=applyArchive(state,action,op.timestamp,official);
  state={...official.reduce(dateState(official,state,op.timestamp),action),...archives};
  clock=mergeVectorClocks(clock,op.vectorClock);serverSeq=seq;
 }
 if(!initialized)throw new Error('PROJECTION_SNAPSHOT_REQUIRED');
 return {state,serverSeq,clock};
}
export async function project(db:DatabaseSync,password:string):Promise<Projection>{
 const official=await officialModule();
 return replay(official,await decodeRows(db.prepare('SELECT wire FROM operations ORDER BY seq').all(),password));
}
// Applies only the operations stored after base. The official reducers return
// new objects, so base itself stays valid. A full-state operation or a sequence
// gap replays the whole stored log instead.
export async function projectIncremental(db:DatabaseSync,password:string,base:Projection):Promise<Projection&{mode:'incremental'|'full';applied:number}>{
 const official=await officialModule();
 const all=await decodeRows(db.prepare('SELECT wire FROM operations WHERE seq>? ORDER BY seq').all(base.serverSeq),password);
 if(all.some(({op})=>FULL_STATE_OPS.includes(op.opType))||(all.length&&all[0].serverSeq!==base.serverSeq+1)){
  return {...await project(db,password),mode:'full',applied:all.length};
 }
 return {...replay(official,all,base),mode:'incremental',applied:all.length};
}
