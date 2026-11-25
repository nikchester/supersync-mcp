import test from 'node:test';import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {makeServer} from '../src/tools.js';
import {loadServerConfig} from '../src/config.js';
import {parsePluginPrefixes,pluginDataPage,prefixAllowed} from '../src/plugin-data.js';

const records=[
 {id:'week-planner:t_b',data:'{"w":"2026-W48","c":"uni","s":"doing"}'},
 {id:'week-planner:t_a',data:'{"w":"2026-W47","c":"career","s":"todo"}'},
 {id:'week-planner:t_empty',data:''},
 {id:'week-planner:cfg',data:'{"limits":{"uni":10}}'},
 {id:'doc-mode:meta',data:'{"secretDocument":"DOC-MODE-SECRET"}'},
 {id:'week-planner-evil:t_x',data:'{"w":"EVIL-PREFIX"}'},
 {id:'week-planner:t_text',data:'not json'},
];
const provider=(pluginUserData:unknown)=>async()=>({serverSeq:42,clock:{fixture:42},state:{tasks:{ids:[],entities:{}},projects:{ids:[],entities:{}},tag:{ids:[],entities:{}},pluginUserData}});

// Pass the plugin state explicitly, also undefined. Without a state argument the shared fixture is used.
async function connect(prefixes:readonly string[],...state:[unknown?]){
 const data=state.length>0?state[0]:records;
 const server=makeServer(provider(data) as never,false,undefined,prefixes);
 const client=new Client({name:'test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 return {client,close:async()=>{await client.close();await server.close();}};
}
function payload(result:any){return result.structuredContent as any;}

test('config: prefixes are empty by default, trimmed, deduplicated and must end with a colon',()=>{
 assert.deepEqual(loadServerConfig({}).pluginDataPrefixes,[]);
 assert.deepEqual(loadServerConfig({PLUGIN_DATA_PREFIXES:' week-planner: , week-planner:,other.plugin_1: '}).pluginDataPrefixes,['week-planner:','other.plugin_1:']);
 for(const bad of ['week-planner','week-planner:t_','*','a b:',':','../x:',' ,x'])assert.throws(()=>loadServerConfig({PLUGIN_DATA_PREFIXES:bad}),/SERVER_CONFIG_INVALID/,bad);
 assert.throws(()=>loadServerConfig({PLUGIN_DATA_PREFIXES:Array.from({length:17},(_,i)=>'p'+i+':').join(',')}),/SERVER_CONFIG_INVALID/);
 assert.equal(parsePluginPrefixes(undefined)?.length,0);
});

test('prefixAllowed accepts narrower prefixes and rejects everything else',()=>{
 assert.ok(prefixAllowed(['week-planner:'],undefined));
 assert.ok(prefixAllowed(['week-planner:'],'week-planner:'));
 assert.ok(prefixAllowed(['week-planner:'],'week-planner:t_'));
 assert.ok(!prefixAllowed(['week-planner:'],'week-planner'));
 assert.ok(!prefixAllowed(['week-planner:'],'doc-mode:'));
 assert.ok(!prefixAllowed([],'week-planner:'));
});

test('get_plugin_data is not registered unless a prefix is configured',async()=>{
 const {client,close}=await connect([]);
 try{
  const names=(await client.listTools()).tools.map(tool=>tool.name);
  assert.ok(!names.includes('get_plugin_data'));
 }finally{await close();}
});

test('get_plugin_data returns only allowed records, sorted, parsed, and hides other plugins',async()=>{
 const {client,close}=await connect(['week-planner:']);
 try{
  const tools=(await client.listTools()).tools;
  const tool=tools.find(item=>item.name==='get_plugin_data');
  assert.ok(tool);assert.equal(tool.annotations?.readOnlyHint,true);assert.equal(tool.annotations?.destructiveHint,false);
  const result=await client.callTool({name:'get_plugin_data',arguments:{}});
  assert.ok(!result.isError);
  const text=JSON.stringify(result);
  assert.ok(!text.includes('DOC-MODE-SECRET'));assert.ok(!text.includes('doc-mode'));assert.ok(!text.includes('EVIL-PREFIX'));
  const body=payload(result);
  assert.equal(body.serverSeq,42);assert.equal(body.total,5);assert.deepEqual(body.prefixes,['week-planner:']);
  assert.deepEqual(body.items.map((item:any)=>item.id),['week-planner:cfg','week-planner:t_a','week-planner:t_b','week-planner:t_empty','week-planner:t_text']);
  const byId=Object.fromEntries(body.items.map((item:any)=>[item.id,item]));
  assert.deepEqual(byId['week-planner:t_a'],{id:'week-planner:t_a',parsed:true,value:{w:'2026-W47',c:'career',s:'todo'}});
  assert.deepEqual(byId['week-planner:t_empty'],{id:'week-planner:t_empty',parsed:false,value:null});
  assert.deepEqual(byId['week-planner:t_text'],{id:'week-planner:t_text',parsed:false,value:null});
 }finally{await close();}
});

test('get_plugin_data narrows by prefix, pages, and rejects a prefix outside the allow list',async()=>{
 const {client,close}=await connect(['week-planner:']);
 try{
  const narrow=payload(await client.callTool({name:'get_plugin_data',arguments:{prefix:'week-planner:t_'}}));
  assert.equal(narrow.total,4);assert.ok(narrow.items.every((item:any)=>item.id.startsWith('week-planner:t_')));
  const page=payload(await client.callTool({name:'get_plugin_data',arguments:{offset:1,limit:2}}));
  assert.equal(page.total,5);assert.deepEqual(page.items.map((item:any)=>item.id),['week-planner:t_a','week-planner:t_b']);
  for(const prefix of ['doc-mode:','week-planner','week-planner-evil:','']){
   const denied=await client.callTool({name:'get_plugin_data',arguments:{prefix}});
   assert.ok(denied.isError,prefix);
   if(prefix!=='')assert.match(JSON.stringify(denied),/PLUGIN_PREFIX_NOT_ALLOWED/);
   assert.ok(!JSON.stringify(denied).includes('DOC-MODE-SECRET'));
  }
 }finally{await close();}
});

test('get_plugin_data copes with missing or malformed plugin state',async()=>{
 for(const data of [undefined,null,{},'x',[null,1,{id:5,data:'{}'},{id:'week-planner:t_ok',data:5}]]){
  const {client,close}=await connect(['week-planner:'],data);
  try{
   const body=payload(await client.callTool({name:'get_plugin_data',arguments:{}}));
   assert.equal(body.total,0);assert.deepEqual(body.items,[]);
  }finally{await close();}
 }
});

test('pluginDataPage never mutates the stored records',()=>{
 const copy=JSON.parse(JSON.stringify(records));
 pluginDataPage({pluginUserData:records},['week-planner:'],{offset:0,limit:100});
 assert.deepEqual(records,copy);
});
