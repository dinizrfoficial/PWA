/*
 * Z-Link Talk Web - audio AMR-WB inteiramente LOCAL.
 * RX: mesmo decoder OpenCORE + jitter buffer usado pelo painel mestre.
 * TX: captura AudioWorklet -> Worker -> VisualOn em WebAssembly -> pacote binario ZL.
 * Nenhuma amostra PCM e enviada para o servidor.
 */
const AUDIO_BASE = String(window.ZLINK_WEB_CONFIG?.apiBase || 'https://servidor.zlinktalk.com.br').replace(/\/+$/,'');
const RX_BUFFER_FRAMES = 60;

export class ZLinkWebAudio {
  constructor({onMeter=()=>{},onStatus=()=>{}}={}) {
    this.onMeter=onMeter; this.onStatus=onStatus;
    this.player=null; this.playerReady=null;
    this.rxChannelId=null; this.rxEpoch=0;this.rxPackets=[];this.rxInitializing=false;
    this.worker=null; this.workerReady=null; this.workerResolve=null; this.workerReject=null;
    this.encoderReady=false; this.pendingFlush=null;
    this.onEncoded=null;
    this.micStream=null;this.micSource=null;this.captureNode=null;
    this.transmitting=false;this.encoderStarted=false;
    this.lastRxMeterAt=0;this.replayToken=0;this.replayPlaying=false;
  }
  meterFromRms(rms){
    if(!Number.isFinite(rms)||rms<0.0007)return 0;
    const db=20*Math.log10(rms);
    return Math.round(Math.max(0,Math.min(100,(db+55)*2.25)));
  }
  async ensurePlayback(){
    if(!window.ZLinkAmrWbPlayer)throw Error('O decoder do painel nao foi carregado.');
    if(!this.player){
      this.player=new window.ZLinkAmrWbPlayer({
        workletUrl:'./zlink-pcm-worklet.js',
        decoderModuleUrl:'./codec/decode-amr.js',
        prebufferMs:80,
        onPcm:pcm=>{
          const now=performance.now();
          if(now-this.lastRxMeterAt<75)return;
          this.lastRxMeterAt=now;
          let sum=0;for(let i=0;i<pcm.length;i+=2)sum+=pcm[i]*pcm[i];
          const rms=Math.sqrt(sum/Math.ceil(pcm.length/2));
          this.onMeter(this.meterFromRms(rms));
        }
      });
    }
    if(!this.playerReady){
      this.playerReady=this.player.ensure(AUDIO_BASE,0.93)
        .then(()=>{this.onStatus('Reproducao AMR-WB habilitada');return true;})
        .catch(e=>{this.playerReady=null;throw e;});
    }
    await this.playerReady;
    // iOS pode suspender o AudioContext ao minimizar a PWA. Retomar
    // dentro do gesto de abrir canal, tocar o icone ou repetir mensagem.
    if(this.player?.ctx?.state==='suspended') await this.player.ctx.resume();
    return true;
  }
  async beginRx(channelId){
    this.stopReplay();
    // O servidor pode entregar start_tx e frames imediatamente depois.
    const epoch=++this.rxEpoch;
    this.rxChannelId=String(channelId||'');
    this.rxPackets=[];this.rxInitializing=true;
    try{
      await this.ensurePlayback();
      if(epoch!==this.rxEpoch)return;
      await this.player.beginTransmission();
      if(epoch!==this.rxEpoch)return;
      this.rxInitializing=false;
      for(const b of this.rxPackets)this.player.feedPacket(b);
      this.rxPackets=[];
    }catch(e){if(epoch===this.rxEpoch)this.rxInitializing=false;this.onStatus('Recepcao AMR-WB: '+e.message);throw e;}
  }
  stopRx(){
    ++this.rxEpoch;this.rxChannelId=null;this.rxPackets=[];this.rxInitializing=false;
    // Como no painel: nao descarta ultimos pacotes ja prontos para tocar.
    this.player?.endTransmission();this.onMeter(0);
  }
  feedPacket(input){
    if(!this.rxChannelId)return false;
    const b=input instanceof Uint8Array?input:new Uint8Array(input);
    if(b.length<8||b[0]!==0x5a||b[1]!==0x4c||b[2]!==1||b[3]!==1)return false;
    if(this.rxInitializing||!this.player?.decoderReady){
      if(this.rxPackets.length>=RX_BUFFER_FRAMES)this.rxPackets.shift();
      this.rxPackets.push(b.slice());return true;
    }
    return this.player.feedPacket(b);
  }
  stopReplay(){
    ++this.replayToken;
    const wasPlaying=this.replayPlaying;
    this.replayPlaying=false;
    if(wasPlaying && !this.rxChannelId){this.player?.resetPlayback();this.onMeter(0);}
  }
  async replayPackets(packets){
    if(this.rxChannelId)throw Error('Uma transmissão está sendo recebida. Aguarde.');
    this.stopReplay();
    const token=++this.replayToken;
    await this.ensurePlayback();
    if(token!==this.replayToken)return;
    await this.player.beginTransmission();
    if(token!==this.replayToken)return;
    this.replayPlaying=true;
    // Mantém o buffer do AudioWorklet pequeno: 5 frames a cada 100 ms.
    // Alimentar tudo de uma vez faria a fila descartar o começo da gravação.
    let i=0;
    while(i<packets.length && token===this.replayToken){
      const until=Math.min(i+5,packets.length);
      for(;i<until;i++)this.player.feedPacket(packets[i]);
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(token!==this.replayToken)return;
    this.player.endTransmission();
    await new Promise(resolve=>setTimeout(resolve,260));
    if(token===this.replayToken){this.replayPlaying=false;this.onMeter(0);}
  }
  async initEncoder(){
    if(this.encoderReady)return true;
    if(this.workerReady)return this.workerReady;
    if(typeof Worker==='undefined')throw Error('Este navegador nao suporta Web Workers.');
    this.workerReady=new Promise((resolve,reject)=>{
      this.workerResolve=resolve;this.workerReject=reject;
      try{
        this.worker=new Worker('./amrwb-encode-worker.js');
        this.worker.onmessage=e=>this.handleWorkerMessage(e.data);
        this.worker.onerror=e=>this.failEncoder(Error(e.message||'Falha ao iniciar o codec AMR-WB local.'));
        this.worker.postMessage({type:'init'});
      }catch(e){this.failEncoder(e);}
    });
    return this.workerReady;
  }
  failEncoder(error){
    const err=error instanceof Error?error:Error(String(error));
    this.encoderReady=false;
    this.onStatus('Codificador AMR-WB local indisponivel: '+err.message);
    const reject=this.workerReject;this.workerReject=null;this.workerResolve=null;
    reject?.(err);
    if(this.pendingFlush){this.pendingFlush.resolve(false);this.pendingFlush=null;}
    try{this.worker?.terminate();}catch{}
    this.worker=null;this.workerReady=null;
  }
  handleWorkerMessage(data){
    if(!data||typeof data!=='object')return;
    switch(data.type){
      case 'ready':
        this.encoderReady=true;
        this.onStatus('AMR-WB local pronto para TX');
        this.workerResolve?.(true);
        this.workerResolve=null;this.workerReject=null;
        break;
      case 'packet':
        if(this.onEncoded&&data.packet instanceof ArrayBuffer){
          this.onEncoded(new Uint8Array(data.packet));
        }
        break;
      case 'drained':
        this.encoderStarted=false;
        if(this.pendingFlush){this.pendingFlush.resolve(true);this.pendingFlush=null;}
        break;
      case 'error':this.failEncoder(Error(data.message||'Falha no encoder WebAssembly.'));break;
    }
  }
  async prepareCapture(onEncoded){
    await this.initEncoder();
    await this.ensurePlayback();
    if(this.micStream){this.onEncoded=onEncoded;return;}
    if(!navigator.mediaDevices?.getUserMedia)throw Error('Microfone nao suportado.');
    if(!this.player?.ctx?.audioWorklet)throw Error('AudioWorklet nao suportado neste navegador.');
    let stream;
    try{
      stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      this.micStream=stream;
      this.onEncoded=onEncoded;
      await this.player.ctx.audioWorklet.addModule('./pcm-capture-worklet.js');
      const node=new AudioWorkletNode(this.player.ctx,'zlink-pcm-capture',{
        numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]
      });
      this.captureNode=node;
      node.port.onmessage=e=>{
        if(!this.transmitting||!this.encoderReady)return;
        const data=e.data;
        if(data?.type==='vu'){this.onMeter(this.meterFromRms(Number(data.rms)||0));return;}
        if(!(data instanceof ArrayBuffer)||data.byteLength!==640)return;
        this.worker?.postMessage({type:'pcm',pcm:data},[data]);
      };
      this.micSource=this.player.ctx.createMediaStreamSource(stream);
      this.micSource.connect(node);
      node.connect(this.player.ctx.destination); // saida silenciosa do worklet
    }catch(error){stream?.getTracks().forEach(t=>t.stop());this.stopCapture();throw error;}
  }
  startCapture(){
    if(!this.encoderReady||!this.worker||!this.micStream||!this.captureNode){
      throw Error('Microfone ou codec AMR-WB local nao inicializado.');
    }
    this.worker.postMessage({type:'start'});
    this.encoderStarted=true;
    this.transmitting=true;
  }
  stopCapture(){
    this.transmitting=false;this.onMeter(0);
    try{this.micSource?.disconnect();}catch{}
    try{this.captureNode?.disconnect();}catch{}
    try{this.captureNode?.port.close();}catch{}
    try{this.micStream?.getTracks().forEach(t=>t.stop());}catch{}
    this.micSource=null;this.captureNode=null;this.micStream=null;
  }
  async flushEncoder(){
    if(!this.encoderStarted||!this.worker)return true;
    if(this.pendingFlush)return this.pendingFlush.promise;
    let resolveFn;
    const promise=new Promise(resolve=>{resolveFn=resolve;});
    this.pendingFlush={resolve:resolveFn,promise};
    this.worker.postMessage({type:'stop'});
    return promise;
  }
  abortEncoder(){
    this.stopCapture();this.encoderStarted=false;this.onEncoded=null;
    this.pendingFlush?.resolve(false);this.pendingFlush=null;
    this.worker?.postMessage({type:'abort'});
  }
  destroy(){
    this.abortEncoder();this.stopRx();
    try{this.worker?.terminate();}catch{}
    this.worker=null;this.workerReady=null;this.encoderReady=false;
    this.player?.close();this.player=null;this.playerReady=null;
  }
}
