/* Z-Link Talk TX: codigo WASM roda no Worker do proprio navegador.
 * PCM de 320 amostras s16le -> VO_AMRWB mode 8 -> frame 61 bytes (TOC incluido).
 * Apenas pacotes ZL/AMR-WB chegam ao WebSocket; PCM nunca sai do dispositivo.
 */
'use strict';
let mod=null,ctx=0,inputPtr=0,outputPtr=0,started=false,seq=0;
let lastErr='';
function error(message){self.postMessage({type:'error',message:String(message)});}
function packetFromFrame(frame){
  const wire=new Uint8Array(6+frame.length);
  wire[0]=0x5a;wire[1]=0x4c;wire[2]=1;wire[3]=1;
  wire[4]=(seq>>>8)&255;wire[5]=seq&255;seq=(seq+1)&65535;
  wire.set(frame,6);
  return wire;
}
async function initialize(){
  if(mod){self.postMessage({type:'ready'});return;}
  try{
    // Arquivo gerado por ferramentas/compilar_codecs.sh (Emscripten).
    importScripts('./codec/amrwb-encoder.js');
    if(typeof self.ZLinkEncoderModule!=='function')throw Error('Fabrica do codec local nao encontrada.');
    mod=await self.ZLinkEncoderModule({locateFile:(path)=>'./codec/'+path});
    if(typeof mod._E_IF_encode!=='function'||typeof mod._malloc!=='function'||!mod.HEAP16||!mod.HEAPU8)
      throw Error('Biblioteca WebAssembly nao exportou as funcoes necessarias.');
    inputPtr=mod._malloc(640);outputPtr=mod._malloc(128);
    if(!inputPtr||!outputPtr)throw Error('Nao foi possivel reservar memoria AMR-WB.');
    self.postMessage({type:'ready'});
  }catch(e){error('Falha ao carregar codec AMR-WB local: '+(e.message||e));}
}
function reset(){
  if(ctx){mod._E_IF_exit(ctx);ctx=0;}
  started=false;
}
self.onmessage=e=>{
  const data=e.data||{};
  try{
    switch(data.type){
      case 'init':initialize();break;
      case 'start':
        if(!mod)throw Error('Codificador nao carregado.');
        reset();ctx=mod._E_IF_init();if(!ctx)throw Error('Falha ao iniciar encoder AMR-WB.');
        started=true;seq=0;break;
      case 'pcm':{
        if(!started||!ctx)return;
        const pcm=data.pcm;
        if(!(pcm instanceof ArrayBuffer)||pcm.byteLength!==640)return;
        mod.HEAP16.set(new Int16Array(pcm),inputPtr>>1);
        const len=mod._E_IF_encode(ctx,8,inputPtr,outputPtr,0);
        if(len!==61)throw Error('Frame AMR-WB invalido: '+len+' bytes (esperado 61).');
        const frame=new Uint8Array(mod.HEAPU8.buffer,outputPtr,len).slice();
        if(((frame[0]>>>3)&15)!==8)throw Error('Modo AMR-WB inesperado no TOC.');
        const wire=packetFromFrame(frame);
        self.postMessage({type:'packet',packet:wire.buffer},[wire.buffer]);
        break;
      }
      case 'stop':reset();self.postMessage({type:'drained'});break;
      case 'abort':reset();break;
      default:break;
    }
  }catch(err){reset();error(err.message||err);}
};
