/** Local static preview server; no image processing or uploads. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.svg':'image/svg+xml'};
createServer(async (request,response)=>{
  try {
    if(!['GET','HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
    const pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
    const file=resolve(root,'.'+(pathname==='/'?'/index.html':pathname)), rel=relative(root,file);
    if(/[\\\0:]/.test(pathname)||rel.startsWith('..')||isAbsolute(rel)) { response.writeHead(403).end();return; }
    const data=await readFile(file);
    response.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});
    response.end(request.method==='HEAD'?undefined:data);
  } catch { response.writeHead(404).end('Not found'); }
}).listen(8765,'127.0.0.1',()=>console.log('RealPixelArt: http://127.0.0.1:8765/'));
