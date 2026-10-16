/* Z-Link Talk Universal — última mensagem local por conta e canal.
 * Guarda somente os quadros AMR-WB já recebidos, sem gravação ou upload ao servidor.
 * Prazo máximo: 24 horas. Limite de gravação: 5 minutos por canal.
 */
const AGE_MS=24*60*60*1000;
const MAX_FRAMES=15000; // 300 s em quadros de 20 ms
const DB='zlinktalk-last-messages-v1';
const STORE='messages';
export class LocalLastMessage {
 constructor(){this.recording=null;this.mem=new Map();this.queue=Promise.resolve();this.dbPromise=null;}
 key(uid,channelId){return String(uid||'')+':'+String(channelId||'');}
 async open(){
  if(!('indexedDB' in globalThis))throw Error('Sem IndexedDB');
  if(this.dbPromise)return this.dbPromise;
  this.dbPromise=new Promise((resolve,reject)=>{
   const request=indexedDB.open(DB,1);
   request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE,{keyPath:'key'});};
   request.onsuccess=()=>resolve(request.result);
   request.onerror=()=>reject(request.error||Error('Armazenamento bloqueado'));
  }).catch(e=>{this.dbPromise=null;throw e;});
  return this.dbPromise;
 }
 async write(entry){
  const db=await this.open();
  return new Promise((resolve,reject)=>{
   const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(entry);
   tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);
  });
 }
 async get(key){
  const db=await this.open();
  return new Promise((resolve,reject)=>{
   const tx=db.transaction(STORE,'readonly');const req=tx.objectStore(STORE).get(key);
   req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });
 }
 persist(entry){
  // Serializa gravações para não deixar o TX antigo sobrepor o mais novo.
  this.queue=this.queue.catch(()=>{}).then(()=>this.write(entry)).catch(e=>console.warn('[LAST MESSAGE] Gravação local indisponível:',e.message));
 }
 begin(uid,channelId,sender){
  if(!uid||!channelId)return;
  if(this.recording)this.end();
  const key=this.key(uid,channelId);
  const entry={key,channelId:String(channelId),sender:String(sender||'Usuário').slice(0,80),time:Date.now(),packets:[]};
  this.recording=entry;this.mem.set(key,entry);
  this.persist(entry); // não conservar áudio antigo se uma nova transmissão começou
 }
 append(packet){
  const r=this.recording;if(!r||r.packets.length>=MAX_FRAMES)return;
  const data=packet instanceof Uint8Array?packet:new Uint8Array(packet);
  if(data.length<8||data[0]!==0x5a||data[1]!==0x4c||data[2]!==1||data[3]!==1)return;
  r.packets.push(data.slice().buffer);
 }
 end(){
  const r=this.recording;if(!r)return;
  this.recording=null;
  // Cópia por valor para impedir edição enquanto o IndexedDB grava.
  const entry={key:r.key,channelId:r.channelId,sender:r.sender,time:r.time,packets:r.packets.slice()};
  this.mem.set(r.key,entry);this.persist(entry);
 }
 async read(uid,channelId){
  const key=this.key(uid,channelId);
  if(this.recording?.key===key)return null;
  // Aguarda commit de eventos recebidos antes do clique do usuário.
  await this.queue;
  let entry=this.mem.get(key);
  if(!entry){try{entry=await this.get(key);}catch(e){console.warn('[LAST MESSAGE] Leitura local indisponível:',e.message);}}
  if(!entry||Date.now()-entry.time>AGE_MS||!Array.isArray(entry.packets)||!entry.packets.length)return null;
  return entry;
 }
}
