import {loadAccessKey,loadServerConfig} from './config.js';
import {loadSingleAccount,type Account} from './accounts.js';
import {createSync} from './sync.js';
import {createWriter} from './write.js';
import {createHttpServer,type Runtime} from './http.js';
const settings=loadServerConfig();
process.umask(0o077);
const accessKey=loadAccessKey();
const account=loadSingleAccount();
const runtimes=new Map<string,Runtime>();
function runtime(value:Account):Runtime{
 let current=runtimes.get(value.identity);
 if(!current){const sync=createSync(value);current={sync,writer:createWriter(value,sync)};runtimes.set(value.identity,current);}
 return current;
}
const server=createHttpServer({settings,accessKey,account,runtime});
server.requestTimeout=30000;server.headersTimeout=10000;
server.listen(settings.port,settings.listenHost,()=>console.log(`MCP listening on ${settings.listenHost}:${settings.port} (writes ${settings.allowWrites?'enabled':'disabled'})`));
void runtime(account).sync.warm();
