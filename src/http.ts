import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {makeServer} from './tools.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {bearerMatches} from './auth.js';
import type {ServerConfig} from './config.js';
import type {Account} from './accounts.js';
import type {createSync} from './sync.js';
import type {createWriter} from './write.js';
import {allowedHostHeaders,hostAllowed} from './hosts.js';
import {createRateLimiter} from './rate-limit.js';
export type Runtime={sync:ReturnType<typeof createSync>;writer:ReturnType<typeof createWriter>};
export type HttpOptions={
 settings:ServerConfig;
 accessKey:string;
 account:Account;
 runtime:(account:Account)=>Runtime;
};
function send(res:ServerResponse,status:number,data:unknown,headers:Record<string,string>={}){
 if(res.headersSent||res.writableEnded)return;
 res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',...headers});
 res.end(JSON.stringify(data));
}
function clientAddress(req:IncomingMessage){
 const address=req.socket.remoteAddress??'unknown';
 return address.startsWith('::ffff:')?address.slice(7):address;
}
export function createHttpServer(options:HttpOptions){
 const {settings,accessKey,account,runtime}=options;
 const limit=createRateLimiter(settings.rateLimitMax,settings.rateLimitWindowMs);
 const server=createServer(async(req,res)=>{
  const path=(req.url??'').split('?')[0];
  if(path==='/healthz'&&req.method==='GET')return send(res,200,{status:'ok'});
  if(path!=='/mcp')return send(res,404,{error:'not_found'});
  const port=req.socket.localPort??settings.port;
  const allowed=allowedHostHeaders(settings.allowedHosts,port);
  const budget=limit(clientAddress(req));
  if(!budget.ok)return send(res,429,{error:'rate_limited'},{'Retry-After':String(budget.retryAfter)});
  if(!hostAllowed(req.headers.host,allowed))return send(res,403,{error:'forbidden_host'});
  if(req.method!=='POST'){res.setHeader('Allow','POST');return send(res,405,{error:'method_not_allowed'});}
  const header=req.headers.authorization;
  if(!header?.startsWith('Bearer ')){
   console.warn(JSON.stringify({event:'auth_rejected',reason:'missing'}));
   return send(res,401,{error:'unauthorized'},{'WWW-Authenticate':'Bearer'});
  }
  const presented=header.slice('Bearer '.length);
  let matches=false;
  try{matches=bearerMatches(presented,accessKey);}catch{matches=false;}
  if(!matches){
   console.warn(JSON.stringify({event:'auth_rejected',reason:'mismatch'}));
   return send(res,401,{error:'unauthorized'},{'WWW-Authenticate':'Bearer'});
  }
  if(Number(req.headers['content-length']??0)>65536)return send(res,413,{error:'request_too_large'});
  const chunks:Buffer[]=[];let size=0;
  try{for await(const chunk of req){size+=chunk.length;if(size>65536){send(res,413,{error:'request_too_large'});return;}chunks.push(chunk);}}
  catch{return;}
  let body:unknown;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return send(res,400,{error:'invalid_json'});}
  const selected=runtime(account);
  const mcp=makeServer(selected.sync.current,settings.allowWrites,selected.writer,settings.pluginDataPrefixes);
  const transport=new StreamableHTTPServerTransport({
   sessionIdGenerator:undefined,enableJsonResponse:true,
   enableDnsRebindingProtection:true,allowedHosts:[...allowed],
  });
  res.on('close',()=>{void transport.close();void mcp.close();});
  try{
   await mcp.connect(transport);
   await transport.handleRequest(req,res,body);
   const method=typeof body==='object'&&body&&'method' in body?String((body as {method?:unknown}).method):'';
   console.info(JSON.stringify({event:'mcp_request',method:['initialize','tools/list','notifications/initialized'].includes(method)?method:'other',status:res.statusCode}));
  }catch{if(!res.headersSent)send(res,500,{error:'mcp_failed'});}
 });
 return server;
}
