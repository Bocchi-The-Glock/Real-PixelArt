/** Validate and stage a self-contained static site. Requires Node 22+, no Python. */
import { readFile, writeFile, readdir, mkdir, cp, rm, lstat, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DEFAULTS } from './core/config.js';
import { paletteCatalog } from './core/sampling.js';

const web=dirname(fileURLToPath(import.meta.url)), root=dirname(web);
const args=process.argv.slice(2), allowed=['--check','--out'];
for(let i=0;i<args.length;i++) {
  if(!allowed.includes(args[i])) throw new Error('Usage: node web/build.mjs [--check] [--out build/pages]');
  if(args[i]==='--out' && !args[++i]) throw new Error('--out requires a path');
}
async function list(directory) {
  const result=[];
  for(const entry of await readdir(resolve(web,directory),{withFileTypes:true})) {
    if(entry.isSymbolicLink()) throw new Error('Website assets cannot be symlinks');
    const name=directory+'/'+entry.name;
    if(entry.isDirectory()) result.push(...await list(name)); else result.push(name);
  }
  return result.sort();
}
const files=['index.html','styles.css','app.js','i18n.js','worker.js',...await list('core'),...await list('assets')].sort();
const hashes={}, combined=createHash('sha256');
let total=0;
for(const name of files) {
  const data=await readFile(resolve(web,name));
  if(/\.(py|pyc|whl|wasm|zip)$/.test(name)) throw new Error('Unexpected runtime asset: '+name);
  hashes[name]={sha256:createHash('sha256').update(data).digest('hex'),bytes:data.length};
  combined.update(name+'\0').update(data); total+=data.length;
}
const libraries=JSON.parse(await readFile(resolve(web,'core/palettes.json'),'utf8'));
const manifest={version:'0.1.0',engine:'javascript',defaults:DEFAULTS,palettes:paletteCatalog(libraries),bundle_sha256:combined.digest('hex'),files:hashes};
const serialized=JSON.stringify(manifest,null,2)+'\n', manifestPath=resolve(web,'core-manifest.json');
if(args.includes('--check')) {
  if(await readFile(manifestPath,'utf8')!==serialized) throw new Error('Stale resource manifest; run node web/build.mjs');
} else await writeFile(manifestPath,serialized);
const outputIndex=args.indexOf('--out');
if(outputIndex>=0) {
  const output=resolve(root,args[outputIndex+1]), build=resolve(root,'build');
  const rel=relative(build,output);
  if(!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('--out must be a subdirectory of this checkout\'s build directory');
  // Never recursively remove an arbitrary path or a redirected generated directory.
  await mkdir(build,{recursive:true});
  if(await realpath(build)!==build) throw new Error('Refusing redirected build directory');
  let ancestor=build;
  for(const part of rel.split(sep)) {
    ancestor=resolve(ancestor,part);
    const stat=await lstat(ancestor).catch(error=>{if(error.code==='ENOENT')return null; throw error;});
    if(stat?.isSymbolicLink()) throw new Error('Refusing redirected output directory');
  }
  await rm(output,{recursive:true,force:true}); await mkdir(output,{recursive:true});
  for(const name of [...files,'core-manifest.json']) {
    await mkdir(dirname(resolve(output,name)),{recursive:true}); await cp(resolve(web,name),resolve(output,name));
  }
  await writeFile(resolve(output,'.nojekyll'),'');
  console.log('Static website: '+output);
}
console.log(`${files.length+1} files, ${((total+Buffer.byteLength(serialized))/1048576).toFixed(2)} MiB; native JavaScript, no Python runtime.`);
