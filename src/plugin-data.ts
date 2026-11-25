// Read-only view of the synced plugin user data (state.pluginUserData).
// Super Productivity stores each record as {id, data}: id is "<plugin>:<key>" and data is a string,
// usually JSON. The view is limited to prefixes the operator lists in PLUGIN_DATA_PREFIXES, so other
// plugins (documents, notes) stay invisible to agents.
export const PLUGIN_PREFIX_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}:$/;
export const MAX_PLUGIN_PREFIXES=16;

export type PluginRecord={id:string;parsed:boolean;value:unknown};
export type PluginPage={total:number;items:PluginRecord[]};

export function parsePluginPrefixes(value:string|undefined):string[]|undefined{
 const prefixes=[...new Set((value??'').split(',').map(item=>item.trim()).filter(Boolean))];
 if(prefixes.length>MAX_PLUGIN_PREFIXES||prefixes.some(prefix=>!PLUGIN_PREFIX_PATTERN.test(prefix)))return undefined;
 return prefixes;
}

export function prefixAllowed(allowed:readonly string[],requested:string|undefined){
 return requested===undefined||allowed.some(prefix=>requested.startsWith(prefix));
}

function parseData(data:string):{parsed:boolean;value:unknown}{
 try{
  const value=JSON.parse(data);
  return {parsed:true,value};
 }catch{return {parsed:false,value:null};}
}

export function pluginDataPage(state:any,allowed:readonly string[],args:{prefix?:string;offset:number;limit:number}):PluginPage{
 const stored=Array.isArray(state?.pluginUserData)?state.pluginUserData:[];
 const selected=stored
  .filter((item:any)=>item&&typeof item.id==='string'&&typeof item.data==='string')
  .filter((item:any)=>allowed.some(prefix=>item.id.startsWith(prefix)))
  .filter((item:any)=>args.prefix===undefined||item.id.startsWith(args.prefix))
  .sort((a:any,b:any)=>a.id<b.id?-1:a.id>b.id?1:0);
 return {
  total:selected.length,
  items:selected.slice(args.offset,args.offset+args.limit).map((item:any)=>({id:item.id,...parseData(item.data)})),
 };
}
