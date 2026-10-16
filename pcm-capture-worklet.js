/* WebAudio AudioWorklet: 128-sample input blocks -> mono PCM s16le 16kHz 20ms.
 * No network call here. Worklet never stores credentials or mic recordings. */
class ZLinkPcmCapture extends AudioWorkletProcessor {
 constructor(){super();this.phase=0;this.pos=0;this.frame=new Int16Array(320);this.last=0;}
 process(inputs,outputs){
   for(const output of outputs)for(const ch of output)ch.fill(0);
   const input=inputs[0]?.[0];if(!input)return true;
   const ratio=16000/sampleRate;
   for(let i=0;i<input.length;i++){
     const sample=Math.max(-1,Math.min(1,input[i]||0));
     this.phase+=ratio;
     if(this.phase>=1){
       // Oversampling low-pass / média simples contra alias (voz).
       this.phase-=1;
       const v=(sample+this.last)*0.5;
       this.frame[this.pos++]=Math.round(v<0?v*32768:v*32767);
       if(this.pos===320){
         const bytes=this.frame.buffer.slice(0);this.port.postMessage(bytes,[bytes]);
         this.frame=new Int16Array(320);this.pos=0;
       }
     }
     this.last=sample;
   }
   return true;
 }
}
registerProcessor('zlink-pcm-capture',ZLinkPcmCapture);
