import {readFileSync,statSync} from 'node:fs';
import {z} from 'zod';
import {parsePluginPrefixes} from './plugin-data.js';
const httpsUrl=z.string().url().refine(value=>{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash;});
const schema=z.object({baseUrl:httpsUrl,accessToken:z.string().min(1),encryptionPassword:z.string().min(1)}).strict();
export function loadCredentials(path='secrets/supersync.json'){
 if((statSync(path).mode & 0o077)!==0)throw new Error('CREDENTIAL_FILE_PERMISSIONS');
 const parsed=schema.safeParse(JSON.parse(readFileSync(path,'utf8')));
 if(!parsed.success)throw new Error('CREDENTIALS_NOT_CONFIGURED');
 return parsed.data;
}
const MIN_ACCESS_KEY_BYTES=32;
function flag(value:string|undefined,fallback:boolean){
 if(value===undefined||value==='')return fallback;
 if(['1','true','yes','on'].includes(value.toLowerCase()))return true;
 if(['0','false','no','off'].includes(value.toLowerCase()))return false;
 return undefined;
}
const serverSchema=z.object({
 listenHost:z.string().min(1),
 port:z.coerce.number().int().min(1).max(65535),
 allowWrites:z.boolean(),
 allowedHosts:z.array(z.string().min(1)).min(1),
 rateLimitMax:z.coerce.number().int().min(1).max(100_000),
 rateLimitWindowMs:z.coerce.number().int().min(1000).max(3_600_000),
 timeZone:z.string().min(1),
 dayStartHour:z.coerce.number().int().min(0).max(23),
 changeLogPath:z.string().regex(/^data\/changes\/[A-Za-z0-9._-]+$/),
 changeLogMaxBytes:z.coerce.number().int().min(256).max(32*1024*1024),
 pluginDataPrefixes:z.array(z.string()),
});
export function loadServerConfig(env:NodeJS.ProcessEnv=process.env){
 const allowWrites=flag(env.MCP_ALLOW_WRITES,false);
 // Prefixes such as "week-planner:" whose synced plugin records the get_plugin_data tool may read. Empty: no such tool.
 const pluginDataPrefixes=parsePluginPrefixes(env.PLUGIN_DATA_PREFIXES);
 const configured=(env.ALLOWED_HOSTS??'127.0.0.1,localhost').split(',').map(value=>value.trim()).filter(Boolean);
 const parsed=serverSchema.safeParse({
  listenHost:env.LISTEN_HOST??'0.0.0.0',
  port:env.PORT??1901,
  allowWrites,
  allowedHosts:[...new Set([...configured,'127.0.0.1','localhost'])],
  rateLimitMax:env.RATE_LIMIT_MAX??120,
  rateLimitWindowMs:env.RATE_LIMIT_WINDOW_MS??60_000,
  timeZone:(env.TZ??'').trim()||'Europe/Brussels',
  dayStartHour:env.DAY_START_HOUR===undefined||env.DAY_START_HOUR===''?4:env.DAY_START_HOUR,
  changeLogPath:env.CHANGE_LOG_PATH||'data/changes/changes.jsonl',
  changeLogMaxBytes:env.CHANGE_LOG_MAX_BYTES||1024*1024,
  pluginDataPrefixes:pluginDataPrefixes??[],
 });
 if(!parsed.success||allowWrites===undefined||pluginDataPrefixes===undefined)throw new Error('SERVER_CONFIG_INVALID');
 try{new Intl.DateTimeFormat('en-CA',{timeZone:parsed.data.timeZone});}catch{throw new Error('SERVER_CONFIG_INVALID');}
 return parsed.data;
}
export function loadAccessKey(env:NodeJS.ProcessEnv=process.env,path=env.ACCESS_KEY_FILE??'secrets/access.key'){
 let fileKey:string|undefined;
 try{
  if((statSync(path).mode & 0o077)!==0)throw new Error('ACCESS_KEY_FILE_PERMISSIONS');
  fileKey=readFileSync(path,'utf8').replace(/\r?\n$/,'');
 }catch(error){
  if(error instanceof Error&&error.message==='ACCESS_KEY_FILE_PERMISSIONS')throw error;
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
 }
 const envKey=env.ACCESS_KEY;
 if(fileKey!==undefined&&envKey!==undefined&&envKey!==fileKey)throw new Error('ACCESS_KEY_MISMATCH');
 const key=fileKey??envKey;
 if(!key)throw new Error('ACCESS_KEY_NOT_CONFIGURED');
 if(Buffer.byteLength(key)<MIN_ACCESS_KEY_BYTES)throw new Error('ACCESS_KEY_TOO_SHORT');
 return key;
}
export type ServerConfig=ReturnType<typeof loadServerConfig>;
