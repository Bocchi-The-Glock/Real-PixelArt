/* Native JavaScript worker. Input images never leave this browser. */
import { pixelize } from './core/pipeline.js';
import { processColors } from './core/sampling.js';
import { decodeImage, decodePng, encodePng } from './core/tools.js';
import { configuration, validateScale } from './core/config.js';
import { drawDiagnostics, diagnosticFiles, diagnosticZip, recolorDiagnostics, runtime } from './core/diagnostics.js';

let bootPromise, busy = false;
const progress = (key,id) => self.postMessage({type:'progress',key,id});
async function resource(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Cannot load local resource '+url+' ('+response.status+')');
  return response.json();
}
function getEngine() {
  return bootPromise ||= (async () => {
    progress('starting');
    const [manifest,libraries] = await Promise.all([resource('./core-manifest.json'),resource('./core/palettes.json')]);
    return {manifest,libraries};
  })().catch(error => { bootPromise=undefined; throw error; });
}
const buffer = bytes => bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
self.onmessage = async ({data}) => {
  if (data.type === 'init') {
    try { const {manifest}=await getEngine(); self.postMessage({type:'ready',id:data.id,manifest}); }
    catch(error) { self.postMessage({type:'error',id:data.id,message:String(error.message||error)}); }
    return;
  }
  if (busy) { self.postMessage({type:'error',id:data.id,message:'An operation is already running.'}); return; }
  busy=true;
  try {
    const {libraries}=await getEngine();
    if(data.type==='export') {
      const output=buffer(await encodePng(await decodePng(data.bytes),validateScale(data.scale)));
      self.postMessage({type:'export',id:data.id,output},[output]); return;
    }
    if(data.type==='recolor') {
      progress('coloring',data.id);
      const colored=processColors(await decodePng(data.bytes),data.settings,libraries);
      const native=buffer(await encodePng(colored.image));
      const debugZip=data.debugZip ? buffer(recolorDiagnostics(data.debugZip,colored)) : null;
      self.postMessage({type:'recolor',id:data.id,native,debugZip,meta:{color_processing:colored.diagnostics,seconds:colored.seconds}},debugZip?[native,debugZip]:[native]); return;
    }
    if(data.type!=='process') throw new Error('Unknown operation');
    progress('processing',data.id);
    const start=performance.now(), request=data.request||{}, config=configuration(request.config||{});
    const source=await decodeImage(data.bytes), decoded=performance.now();
    const result=pixelize(source,config,libraries);
    const readTime=(decoded-start)/1000;
    result.timings.read_preprocess+=readTime; result.timings.total+=readTime;
    const stem=(request.name||'image.png').replace(/\.[^.]*$/,'').replace(/[\/\\:*?"<>|\x00-\x1f]/g,'').replace(/^[. ]+|[. ]+$/g,'')||'image';
    const reusePreview=Array.isArray(request.preview_size)&&request.preview_size[0]===source.width&&request.preview_size[1]===source.height&&source.metadata.frames===1;
    const native=buffer(await encodePng(result.image));
    const base=result.diagnostics.color_processing.applied ? buffer(await encodePng(result.native_image)) : native.slice(0);
    const output=config.scale===1?native.slice(0):buffer(await encodePng(result.image,config.scale));
    const original=reusePreview?null:buffer(await encodePng(source));
    const diagnosticStart=performance.now();
    const images=request.debug?await drawDiagnostics(result):{};
    result.timings.diagnostics=(performance.now()-diagnosticStart)/1000;
    result.timings.total_with_export=(performance.now()-start)/1000;
    const message={type:'result',id:data.id,output,native,base,original,diagnostics:{},meta:{
      name:stem+'.png',grid:result.grid,confidence:result.confidence,input:source.metadata,reuse_preview:reusePreview,
      timings:result.timings,warnings:result.diagnostics.warnings,config:request.config||{},debug:!!request.debug,
      color_processing:result.diagnostics.color_processing,export_size:[result.image.width*config.scale,result.image.height*config.scale],runtime,
    }};
    const transfers=[output,native,base]; if(original) transfers.push(original);
    if(request.debug) {
      message.debugZip=buffer(diagnosticZip(diagnosticFiles(result,images,config.scale),stem)); transfers.push(message.debugZip);
      for(const [name,png] of Object.entries(images)) { message.diagnostics[name]=buffer(png); transfers.push(message.diagnostics[name]); }
    }
    self.postMessage(message,transfers);
  } catch(error) {
    const message=String(error.message||error);
    self.postMessage({type:'error',id:data.id,message,code:/MemoryError|allocation|out of memory|Invalid typed array length|Array buffer allocation/i.test(message)?'memory':'processing'});
  } finally { busy=false; }
};
