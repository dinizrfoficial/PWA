// Z-Link Talk Web — PTT RX AMR-WB + TX AMR-WB codificado no navegador.
import { ZLinkWebAudio } from './audio.js';
import { LocalLastMessage } from './last-message.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, setPersistence, browserLocalPersistence, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification, reload, sendPasswordResetEmail, onAuthStateChanged, signOut as firebaseSignOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

const cfg = window.ZLINK_WEB_CONFIG || {};
const $ = (id) => document.getElementById(id);
const escapeHTML = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const apiBase = String(cfg.apiBase || '').replace(/\/+$/, '');
const validAvatar = (s) => typeof s === 'string' && (/^data:image\/(?:jpeg|jpg|webp|png);base64,[a-z0-9+/=\r\n]+$/i.test(s) || /^https:\/\/[^\s]+$/i.test(s));
const avatarMarkup = (avatar, name) => validAvatar(avatar) ? `<img alt="" src="${escapeHTML(avatar)}">` : escapeHTML((name || '?').trim().charAt(0).toUpperCase());
const state = { user:null, auth:null, profile:null, channels:[], selected:null, users:[], ws:null, wsReady:false, sessionId:'', reconnect:null, sessionEnded:false, sessionClosing:false, checkingSession:false, replayActive:false, screen:'login', signupInProgress:false, registrationRecovery:null, registrationStatus:null, registrationPolicy:null, selectedAccessPlan:'', paymentRef:'', defaultChannelId:null, createAvatar:'', uploadTarget:null, deviceId:'', status:'Aguardando conexão', lastRxAt:0, txUser:'', rxTransmission:null, usersChannelId:null, webAudioReady:false, holding:false, pendingTx:false, txGranted:false, txStopping:false, txStopTimer:null, txStartAt:0, txClock:null };
let toastTimer=null, authInitialized=false, modalResolver=null, queryOffset=0, lastSearchQuery='', queryHasMore=false;
let loginRoutingPromise=null;
const lastMessage = new LocalLastMessage();
// Mostra a restauracao da sessao salva sem expor o formulario de login.
function hideStartupOverlay(){const panel=$('startup-session');if(panel)panel.hidden=true;}

// O nivel inicia no centro e acende segmentos espelhados ate as pontas.
const VU_SIDE_BARS = 12;
function vuDistanceFromCenter(index){
 return index < VU_SIDE_BARS ? VU_SIDE_BARS - 1 - index : index - VU_SIDE_BARS;
}
function createVuMeter(){
 const host=$('meter-bars');
 if(!host)return;
 host.replaceChildren();
 for(let index=0;index<VU_SIDE_BARS*2;index++){
   const distance=vuDistanceFromCenter(index);
   const segment=document.createElement('i');
   segment.className=distance>=10?'vu-red':distance>=8?'vu-orange':distance>=6?'vu-yellow':'vu-green';
   segment.setAttribute('aria-hidden','true');
   host.appendChild(segment);
 }
 updateVuMeter(0);
}
function updateVuMeter(value){
 const level=Math.max(0,Math.min(100,Number(value)||0));
 const meterText=$('meter-value');
 if(meterText)meterText.textContent=Math.round(level)+'%';
 const litPerSide=Math.ceil(level*VU_SIDE_BARS/100);
 const bars=$('meter-bars')?.children;
 if(!bars)return;
 for(let index=0;index<bars.length;index++){
   bars[index].classList.toggle('on',vuDistanceFromCenter(index)<litPerSide);
 }
}
const audio = new ZLinkWebAudio({
 onStatus: message=>{console.warn('[WEB AUDIO]',message);if(!$('ptt-note'))return;const m=String(message||'').toLowerCase();if(m.includes('pronto')||m.includes('habilitad'))$('ptt-note').textContent='Áudio pronto';else if(m.includes('falha')||m.includes('indispon')||m.includes('erro'))$('ptt-note').textContent='Áudio indisponível. Verifique as permissões.';},
 onMeter: updateVuMeter
});
function setAudioReadyUI(ok){
 const b=$('audio-unlock');if(!b)return;
 b.textContent=ok?'🔊':'🔇';
 b.setAttribute('aria-label',ok?'Áudio habilitado':'Ativar áudio');
 b.title=ok?'Som habilitado':'Ativar áudio';
 b.classList.toggle('needs-unlock',!ok);
}
function updateReplayUI(){
 const b=$('ptt-last');if(!b)return;
 b.textContent=state.replayActive?'■ Parar última mensagem':'◌ Última mensagem';
 b.setAttribute('aria-pressed',String(!!state.replayActive));
}
async function playLastMessage(){
 if(!state.selected || !state.user)return;
 if(state.replayActive){audio.stopReplay();state.replayActive=false;updateReplayUI();return;}
 if(state.holding||state.pendingTx||state.txGranted||state.txStopping||audio.rxChannelId){toast('Aguarde o fim da transmissão para ouvir a última mensagem.');return;}
 const playback=audio.ensurePlayback(); // gesto do usuário: desbloqueio de áudio no iOS
 const entry=await lastMessage.read(state.user.uid,state.selected.id);
 if(!entry?.packets?.length){playback.catch(()=>{});toast('Não existe última mensagem recebida neste canal por este dispositivo.');return;}
 await playback;
 if(audio.rxChannelId){toast('Uma transmissão começou. Aguarde para ouvir a gravação.');return;}
 state.replayActive=true;updateReplayUI();
 $('ptt-note').textContent='Reproduzindo última mensagem de '+(entry.sender||'Usuário');
 try{await audio.replayPackets(entry.packets);}
 finally{
  state.replayActive=false;updateReplayUI();
  if(state.screen==='ptt')$('ptt-note').textContent='Segure o PTT para falar';
 }
}
function updateTxUI(){
  const button=$('ptt-button');if(!button)return;
  button.disabled=!state.webAudioReady || !state.wsReady || !state.selected || state.txStopping;
  button.classList.toggle('transmitting',state.txGranted);
  $('tx-status').textContent=state.txGranted?'TRANSMITINDO':state.pendingTx?'Solicitando':'Pronto';
  updateCrossChannelBanner();
}
function sendAmr(packet){
  // A funcao so recebe frames AMR-WB completos, nunca PCM.
  if(!state.webAudioReady||!state.txGranted||!state.wsReady)return;
  if(!(packet instanceof Uint8Array)||packet.length<8||packet[0]!==0x5a||packet[1]!==0x4c||packet[3]!==1)return;
  const ws=state.ws;
  if(ws?.readyState===WebSocket.OPEN&&ws.bufferedAmount<48000)ws.send(packet);
}
function stopTxNow(){
  if(!state.txGranted&&!state.pendingTx)return;
  state.holding=false;
  audio.stopCapture();
  if(state.pendingTx&&!state.txGranted){
    state.pendingTx=false;
    audio.abortEncoder();
    sendWS({type:'stop_tx'});
    updateTxUI();return;
  }
  if(state.txGranted&&!state.txStopping){
    state.txStopping=true;
    const timer=setTimeout(finishTx,1250);
    state.txStopTimer=timer;
    audio.flushEncoder().then(()=>{
      if(state.txStopping&&state.txStopTimer===timer)finishTx();
    }).catch(()=>finishTx());
  }
  updateTxUI();
}
function finishTx(){
  clearTimeout(state.txStopTimer);state.txStopTimer=null;
  if(state.txGranted||state.pendingTx)sendWS({type:'stop_tx'});
  state.holding=false;state.pendingTx=false;state.txGranted=false;state.txStopping=false;
  clearInterval(state.txClock);state.txClock=null;
  $('ptt-clock').textContent='◷ 00:00.0';
  updateTxUI();
}
async function beginTx(){
  if(!state.webAudioReady||!state.wsReady||!state.selected||state.holding||state.pendingTx||state.txStopping||state.replayActive)return;
  state.holding=true;state.pendingTx=true;updateTxUI();
  try{
    await audio.prepareCapture(sendAmr);
    if(!state.holding||!state.wsReady){state.pendingTx=false;audio.abortEncoder();updateTxUI();return;}
    // Mesmo controle do Android. O servidor autoriza antes de enviar tx_granted.
    sendWS({type:'start_tx',channelId:state.selected.id});
    setTimeout(()=>{
      if(state.pendingTx&&!state.txGranted){
        state.pendingTx=false;state.holding=false;audio.abortEncoder();
        sendWS({type:'stop_tx'});updateTxUI();
        toast('O sistema nao confirmou o PTT. Verifique a atualizacao de sinalizacao.');
      }
    },2800);
  }catch(error){state.pendingTx=false;state.holding=false;audio.abortEncoder();updateTxUI();handleError(error);}
}
function txGranted(data){
  if(!state.pendingTx||String(data.channelId||'')!==String(state.selected?.id||'')){
    sendWS({type:'stop_tx'});return;
  }
  state.pendingTx=false;state.txGranted=true;
  if(!state.holding){stopTxNow();return;}
  try{
    audio.startCapture();state.txStartAt=performance.now();
    clearInterval(state.txClock);
    state.txClock=setInterval(()=>{
      if(!state.txGranted)return;
      const d=Math.max(0,performance.now()-state.txStartAt);
      $('ptt-clock').textContent=`◷ ${String(Math.floor(d/60000)).padStart(2,'0')}:${String(Math.floor(d/1000)%60).padStart(2,'0')}.${Math.floor(d%1000/100)}`;
    },100);
    $('ptt-note').textContent='Transmitindo';
  }catch(error){handleError(error);stopTxNow();}
  updateTxUI();
}

function toast(msg){const el=$('toast');el.textContent=String(msg);el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),4300);}
function status(msg){
 state.status=msg;
 $('connection').textContent=state.screen==='login'?'Z-Link Talk Universal':msg;
 $('ptt-availability').textContent=msg;
 updateCrossChannelBanner();
}
// Mesma contagem da lista de usuarios do servidor: todos os usuarios online
// com o canal ativo, mesmo que estejam visualizando outro canal.
function renderChannelPresence(){
 const text=$('ptt-speaker'), count=$('ptt-count');
 if(!text||!count||!state.selected)return;
 const currentId=String(state.selected.id||'');
 if(!state.wsReady||String(state.usersChannelId||'')!==currentId){
  text.textContent=state.wsReady?'Consultando usuários conectados…':'Aguardando conexão';
  count.textContent='—';
  return;
 }
 const users=Array.isArray(state.users)?state.users:[];
 const includesSelf=users.some(u=>String(u.id||u.uid||'')===String(state.user?.uid||''));
 const total=Math.max(1,users.length+(includesSelf?0:1));
 const others=Math.max(0,total-1);
 text.textContent=others===0?'Apenas você está conectado':others===1?'Você e 1 usuário estão conectados':`Você e ${others} usuários estão conectados`;
 count.textContent=String(total);
}
// O servidor informa o canal real do RX. Se for diferente do canal aberto,
// o aviso aparece animado sobre o mesmo cabecalho, sem criar uma faixa extra.
function updateCrossChannelBanner(){
 const header=document.querySelector('#ptt-screen .ptt-heading');
 const banner=$('ptt-other-tx');if(!header||!banner)return;
 const rx=state.rxTransmission;
 const cross=state.screen==='ptt'&&state.wsReady&&!state.txGranted&&!!rx&&
  !!state.selected&&String(rx.channelId)!==String(state.selected.id);
 header.classList.toggle('is-other-tx',cross);
 banner.hidden=!cross;
 if(!cross)return;
 const match=state.channels.find(c=>String(c.id)===String(rx.channelId));
 const channelName=rx.channelName||match?.name||`Canal ${rx.channelId}`;
 $('ptt-other-channel').textContent=channelName;
 $('ptt-other-speaker').textContent=`${rx.speaker||'Usuário'} transmitindo`;
 banner.setAttribute('aria-label',`Outro canal transmitindo: ${channelName}. ${rx.speaker||'Usuário'}. Toque para abrir.`);
}
function openTransmittingChannel(){
 const rx=state.rxTransmission;if(!rx)return;
 const channel=state.channels.find(c=>String(c.id)===String(rx.channelId));
 if(channel&&channel.enabled!==false&&!channel.blocked&&!channel.removed)openChannel(channel).catch(handleError);
 else toast('O canal que está transmitindo não está disponível na sua lista.');
}
// Adapta o PTT as dimensoes REAIS do espaco restante, como na Activity Android.
// ResizeObserver acompanha mudancas da janela, rotação, barra de navegacao e teclado.
let pttResizeFrame=0;
function resizePTT(){
 const host=document.querySelector('#ptt-screen .ptt-control');
 const button=$('ptt-button');
 if(!host||!button||state.screen!=='ptt')return;
 const width=host.clientWidth,height=host.clientHeight;
 if(width<60||height<60)return;
 const landscape=window.matchMedia('(orientation: landscape)').matches;
 const gap=landscape?18:16;
 const usableW=Math.max(0,width-gap),usableH=Math.max(0,height-gap);
 let w,h;
 if(landscape){const ratio=1.45;w=Math.min(usableW,usableH*ratio,620);h=w/ratio;}
 else{w=Math.min(usableW,usableH,360);h=w;}
 if(w<65||h<50)return;
 button.style.setProperty('--ptt-computed-width',`${Math.floor(w)}px`);
 button.style.setProperty('--ptt-computed-height',`${Math.floor(h)}px`);
}
function scheduleResizePTT(){cancelAnimationFrame(pttResizeFrame);pttResizeFrame=requestAnimationFrame(resizePTT);}

function screen(name){if(name!=='ptt'&&name!=='users'){audio.stopReplay();state.replayActive=false;updateReplayUI();}if(name!=='ptt'&&name!=='users'&&(state.holding||state.txGranted))stopTxNow();state.screen=name;$('connection').textContent=name==='login'?'Z-Link Talk Universal':state.status;document.querySelectorAll('.screen').forEach(el=>el.classList.toggle('active',el.id===`${name}-screen`));window.scrollTo({top:0,behavior:'instant'});if(name==='ptt'){renderChannelPresence();scheduleResizePTT();}updateCrossChannelBanner();if(name!=='ptt'&&name!=='users') sendWS({type:'channel_view_presence',channelId:null});if(name==='ptt' && state.selected)sendWS({type:'channel_view_presence',channelId:state.selected.id});}
// A PWA instalada usa uma unica URL. Interceptamos o Voltar do sistema para
// navegar pelas telas sem que o navegador feche o aplicativo imediatamente.
function showCloseGuidance(kind){
 const platform=/iPad|iPhone|iPod/i.test(navigator.userAgent)?'iPhone':/Android/i.test(navigator.userAgent)?'Android':'PC';
 const msg=kind==='min'
  ?(platform==='iPhone'?'Deslize para cima para voltar à Tela de Início. O aplicativo ficará em segundo plano, sujeito às restrições de áudio do iOS.':platform==='Android'?'Use o gesto ou botão Início do Android para voltar à tela inicial. A PWA poderá ser suspensa pelo sistema.':'Use o botão de minimizar da janela ou volte à área de trabalho.')
  :(platform==='iPhone'?'Abra o seletor de aplicativos e deslize a janela do Z-Link Talk para cima.':platform==='Android'?'Abra os aplicativos recentes e deslize o Z-Link Talk para fechar.':'Feche a janela do Z-Link Talk no botão X.');
 modal(kind==='min'?'Como minimizar':'Como fechar',area=>{
  const wrapper=document.createElement('div');wrapper.className='modal-stack';
  const p=document.createElement('p');p.textContent=msg;
  const note=document.createElement('p');note.textContent='Minimizar ou fechar não significa sair da conta. O navegador pode suspender o áudio em segundo plano.';
  const ok=document.createElement('button');ok.className='primary';ok.textContent='ENTENDI';ok.onclick=closeModal;
  wrapper.append(p,note,ok);area.append(wrapper);
 });
}
// Navegacao exclusiva da PWA instalada. Paginas Web/PWA nao tem uma API
// padronizada para minimizar o proprio processo: manter sessao, RX/TX e
// WebSocket intactos e orientar o gesto Início, sem simular encerramento.
function requestMinimize(){
 const platform=/iPad|iPhone|iPod/i.test(navigator.userAgent)?'iPhone':/Android/i.test(navigator.userAgent)?'Android':'PC';
 if(platform==='Android')toast('Para minimizar sem sair da conta, use o botão Início do Android.');
 else if(platform==='iPhone')toast('Para minimizar, volte à Tela de Início pelo gesto do iPhone.');
 else toast('Para minimizar, use o controle da janela ou a área de trabalho.');
}
function exitSubmenu(){
 menu('Sair',[
  {label:'Fechar completamente',danger:true,fn:confirmCloseApp},
  {label:'Minimizar',fn:()=>showCloseGuidance('min')},
  {label:'Voltar',fn:pttScreenMenu}
 ]);
}
// O menu de operacao no canal e independente das opcoes do canal (avatar).
function pttScreenMenu(){
 // Mesmo menu geral nos tres pontinhos de Canais e no menu da tela PTT.
 menu('Menu',[
  {label:'Editar perfil',fn:profileMenu},
  {label:'Sair',fn:exitSubmenu},
  {label:'Desconectar',danger:true,fn:confirmDisconnect}
 ]);
}
async function confirmDisconnect(){
 const accepted=await confirmModal(
  'Desconectar',
  'Deseja desconectar sua conta neste dispositivo e voltar à tela de login? A sessão será encerrada e será necessário entrar novamente.',
  'DESCONECTAR'
 );
 if(!accepted)return;
 await logout();
 registrationMessage('login-message','Conta desconectada. Entre novamente para continuar.');
}
async function confirmCloseApp(){
 const accepted=await confirmModal(
  'Fechar completamente',
  'Deseja encerrar a conexão com o canal e parar o PTT neste dispositivo? O acesso à conta será mantido. Para fechar a janela da PWA, utilize o controle do seu aparelho.',
  'ENCERRAR CONEXÃO'
 );
 if(!accepted)return;
 // PWA nao tem permissao universal para fechar a propria janela.
 // Interrompe de verdade o audio, o WebSocket e suas reconexoes.
 state.sessionEnded=true;
 stopConnection();
 state.sessionId='';
 state.replayActive=false;
 updateReplayUI();
 status('Comunicação encerrada');
 const platform=/iPad|iPhone|iPod/i.test(navigator.userAgent)?'iPhone':/Android/i.test(navigator.userAgent)?'Android':'PC';
 const instruction=platform==='iPhone'
  ?'Abra o seletor de aplicativos e feche a janela do Z-Link Talk.'
  :platform==='Android'
   ?'Abra os aplicativos recentes e deslize o Z-Link Talk para fechar a janela.'
   :'Feche a janela pelo botão X do sistema.';
 modal('Comunicação encerrada',area=>{
  const box=document.createElement('div');box.className='modal-stack';
  const msg=document.createElement('p');msg.textContent='A transmissão, a recepção e a conexão com o canal foram interrompidas.';
  const help=document.createElement('p');help.textContent=instruction;
  const again=document.createElement('button');again.className='primary';again.textContent='ABRIR NOVAMENTE';
  again.onclick=()=>location.reload();
  box.append(msg,help,again);area.append(box);
 });
}
function goBack(){
 // Primeiro fecha o menu/diálogo atual, como no Android.
 if(!$('modal').hidden){closeModal();return;}
 switch(state.screen){
  case 'users':screen('ptt');break;
  case 'ptt':case 'search':case 'create':case 'account':screen('channels');break;
  case 'register':screen('login');break;
  case 'verify':case 'contribution':
   confirmModal('Voltar ao login','Deseja sair desta etapa e voltar à tela de login?','VOLTAR AO LOGIN')
    .then(yes=>{if(yes)logout().catch(handleError);});break;
  case 'channels':requestMinimize();break;
  default:if(state.user)screen('channels');else requestMinimize();
 }
}
let systemBackReady=false;
function setupSystemBack(){
 if(systemBackReady)return;
 systemBackReady=true;
 if(window.ZLINK_STANDALONE){
  // Um estado extra evita o fechamento imediato pelo botao Voltar do Android.
  try{
   history.replaceState({...history.state,zlinkRoot:true},'',location.href);
   history.pushState({zlinkBackGuard:true},'',location.href);
   window.addEventListener('popstate',()=>{
    // Recoloca a sentinela, permitindo repetidos Voltar sem sair da PWA.
    try{history.pushState({zlinkBackGuard:true},'',location.href);}catch(error){console.warn('[NAV]',error);}
    goBack();
   });
  }catch(error){console.warn('[NAV] Não foi possível ativar o botão Voltar:',error);}
 }
}

function closeModal(){ $('modal').hidden=true;$('modal-content').replaceChildren();const r=modalResolver;modalResolver=null;if(r)r(false); }
function modal(title,render){hideStartupOverlay();closeModal();$('modal-title').textContent=title;const area=$('modal-content');if(typeof render==='string')area.innerHTML=render;else render(area);$('modal').hidden=false;}
function menu(title,entries){modal(title,area=>{const list=document.createElement('div');list.className='modal-menu';for(const entry of entries){const btn=document.createElement('button');btn.textContent=entry.label;if(entry.danger)btn.classList.add('danger');btn.onclick=()=>{closeModal();Promise.resolve().then(entry.fn).catch(handleError)};list.appendChild(btn);}area.append(list);});}
function promptModal(title,fields,submitLabel='Salvar'){return new Promise(resolve=>{modal(title,area=>{const form=document.createElement('form');form.className='modal-stack';for(const field of fields){const label=document.createElement('label');label.textContent=field.label;const input=document.createElement(field.type==='textarea'?'textarea':'input');input.name=field.name;input.value=field.value||'';input.required=!!field.required;if(field.maxLength) input.maxLength=field.maxLength;if(field.type && field.type!=='textarea')input.type=field.type;label.append(input);form.append(label);}const button=document.createElement('button');button.className='primary';button.textContent=submitLabel;button.type='submit';form.append(button);form.onsubmit=e=>{e.preventDefault();const values=Object.fromEntries(new FormData(form));const r=modalResolver;modalResolver=null;closeModal();r?.(values);};area.append(form);});modalResolver=resolve;});}
function confirmModal(title,message,affirmative='Confirmar'){return new Promise(resolve=>{modal(title,area=>{const box=document.createElement('div');box.className='modal-stack';const p=document.createElement('p');p.textContent=message;box.append(p);const yes=document.createElement('button');yes.className='primary';yes.textContent=affirmative;yes.onclick=()=>{const r=modalResolver;modalResolver=null;closeModal();r?.(true)};box.append(yes);const no=document.createElement('button');no.className='outline';no.textContent='Cancelar';no.onclick=closeModal;box.append(no);area.append(box);});modalResolver=resolve;});}
function handleError(error){const msg=error?.message||'Não foi possível concluir a operação.';toast(msg);console.error('[ZLINK WEB]',msg);}
function uuid(){if(crypto.randomUUID)return crypto.randomUUID();return Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');}
function deviceId(){const key='zlink_web_device_id_v1';let id=localStorage.getItem(key);if(!id){id='web_'+uuid();localStorage.setItem(key,id);}return id;}
async function api(route,{method='GET',body=null}={}){
 if(!state.user) throw new Error('Entre na sua conta.');
 const jwt=await state.user.getIdToken();
 const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),18000);
 try{
  const response=await fetch(`${apiBase}${route}`,{method,cache:'no-store',signal:controller.signal,headers:{'Authorization':`Bearer ${jwt}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  let data={};try{data=await response.json()}catch{};
  if(!response.ok || data.success===false){const err=new Error(data.error||`Falha de conexão (${response.status}).`);err.code=data.code;err.httpStatus=response.status;throw err;}return data;
 }finally{clearTimeout(timeout);}
}
// Cadastro Web: mesmo fluxo v2 do Android, todas as regras aplicadas pelo servidor.
const REGISTRATION_FLOW_VERSION = 2;
const flowBody = body => ({...body, registrationFlowVersion:REGISTRATION_FLOW_VERSION});
async function publicApi(route,{method='GET',body=null}={}){
 const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),20000);
 try{
  const res=await fetch(`${apiBase}${route}`,{method,cache:'no-store',signal:ctrl.signal,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const data=await res.json().catch(()=>({}));
  if(!res.ok||data.success===false){const err=new Error(data.error||`Operação indisponível (HTTP ${res.status})`);err.code=data.code;err.httpStatus=res.status;throw err;}
  return data;
 }finally{clearTimeout(timer);}
}
function registrationMessage(id,message){$(id).textContent=message||'';}
async function loadRegistrationPolicy(){
 const policy=await publicApi('/api/registration-policy');state.registrationPolicy=policy;return policy;
}
async function openRegistration(){
 if(!state.auth){toast('O cadastro está temporariamente indisponível. Tente novamente mais tarde.');return;}
 screen('register');$('register-retry').hidden=!state.registrationRecovery;registrationMessage('register-message','Verificando se novos cadastros estão disponíveis...');
 try{const p=await loadRegistrationPolicy();registrationMessage('register-message',p.registrationAvailable?'':'Novos cadastros estão temporariamente indisponíveis.');$('register-submit').disabled=!p.registrationAvailable;}
 catch(e){registrationMessage('register-message',e.message);$('register-submit').disabled=true;}
}
async function releaseReservation(username,reservationId){
 if(!reservationId)return;
 await publicApi('/api/release-username',{method:'POST',body:flowBody({username,reservationId})}).catch(e=>console.warn('[REGISTER] Não foi possível liberar reserva:',e.message));
}
async function startPendingRegistration(username,reservationId){
 const result=await api('/api/pending-registration/start',{method:'POST',body:flowBody({username,reservationId})});
 state.registrationRecovery=null;
 state.registrationStatus=result;
 try{await sendEmailVerification(state.auth.currentUser);}catch(e){
  console.warn('[REGISTER] Falha ao enviar confirmação:',e.code||e.message);
  showPendingRegistration(result);
  registrationMessage('verify-message','Cadastro iniciado, mas não foi possível enviar o e-mail. Use Reenviar e-mail de confirmação.');
  return;
 }
 showPendingRegistration(result);
 registrationMessage('verify-message','E-mail de confirmação enviado. Confira sua caixa de entrada.');
}
async function createAccountFromForm(){
 const username=$('register-username').value.trim().normalize('NFC');
 const email=$('register-email').value.trim().toLowerCase();
 const password=$('register-password').value;
 const confirm=$('register-confirm').value;
 if(username.length<3||username.length>20)throw Error('O nome deve ter entre 3 e 20 caracteres.');
 if(password.length<6)throw Error('A senha deve ter pelo menos 6 caracteres.');
 if(password!==confirm)throw Error('As senhas não coincidem.');
 if(state.auth.currentUser)throw Error('Saia da conta atual antes de criar outra.');
 const policy=await loadRegistrationPolicy();
 if(!policy.registrationAvailable)throw Error('O cadastro está indisponível no momento.');
 const checked=await publicApi('/api/check-registration',{method:'POST',body:flowBody({username,email})});
 if(checked.usernameExists||checked.usernameAvailable===false)throw Error('Este nome de usuário já está cadastrado.');
 if(checked.emailExists||checked.emailAvailable===false)throw Error('Este e-mail já está cadastrado.');
 const reserved=await publicApi('/api/reserve-username',{method:'POST',body:flowBody({username})});
 if(!reserved.reservationId)throw Error('O sistema não retornou a reserva do nome.');
 state.signupInProgress=true;
 let created=false;
 try{
  const userCred=await createUserWithEmailAndPassword(state.auth,email,password);
  state.user=userCred.user;created=true;
  await userCred.user.getIdToken(true);
  await startPendingRegistration(username,reserved.reservationId);
 }catch(error){
  if(!created)await releaseReservation(username,reserved.reservationId);
  else{
   // Não excluir contas parcialmente criadas sem confirmar se o backend persistiu o cadastro.
   // É possível retomar /pending-registration/start com a reserva existente.
   state.registrationRecovery={username,reservationId:reserved.reservationId};
   $('register-retry').hidden=false;
  }
  throw error;
 }finally{state.signupInProgress=false;$('register-password').value='';$('register-confirm').value='';}
}
async function retryRegistration(){
 const recovery=state.registrationRecovery;
 if(!state.user||!recovery)throw Error('Entre novamente para retomar o cadastro.');
 state.signupInProgress=true;
 try{await startPendingRegistration(recovery.username,recovery.reservationId);$('register-retry').hidden=true;}
 finally{state.signupInProgress=false;}
}
function showPendingRegistration(s){
 state.registrationStatus=s;
 $('verify-email-address').textContent=s.email||state.user?.email||'';
 screen('verify');registrationMessage('verify-message','');
}
async function checkEmailVerification(){
 if(!state.user)throw Error('Entre novamente para confirmar seu e-mail.');
 await reload(state.user);await state.user.getIdToken(true);
 const s=await api('/api/pending-registration/status');
 if(!s.emailVerified){showPendingRegistration(s);registrationMessage('verify-message','O endereço ainda não foi confirmado. Abra o link recebido e tente novamente.');return;}
 await routeRegistrationStatus(s);
}
async function finalizePending(s,trial=false){
 await api('/api/finalize-registration',{method:'POST',body:flowBody({username:s.username,reservationId:s.reservationId,oneTimeTrial:trial})});
 state.registrationStatus=null;state.paymentRef='';
 await initAccount();
}
async function routeRegistrationStatus(s){
 if(!state.user||state.signupInProgress)return;
 state.registrationStatus=s;
 if(s.pending){
  if(!s.emailVerified){showPendingRegistration(s);return;}
  if(s.paymentRequired){
   if(s.paymentStatus==='approved'){await finalizePending(s);return;}
   await showContributions(s);return;
  }
  await finalizePending(s);return;
 }
 if(s.active){
  // A obrigacao historica de contribuicao pode permanecer no perfil mesmo
  // durante um periodo pago valido. O estado calculado pelo servidor e a fonte
  // autoritativa; nao bloquear apenas por contributionRequired.
  const access=await api('/api/access/status');
  if(access.active===true && access.code==='ACCESS_ACTIVE'){
   await initAccount();return;
  }
  if(access.active===false || access.code==='PAYMENT_REQUIRED'){
   await showContributions({...s,accessExpired:true});return;
  }
  throw Error('Nao foi possivel confirmar a situacao da sua conta. Tente novamente.');
 }
 // Não tornar uma conta incompleta elegível a entrar no PTT.
 screen('login');registrationMessage('login-message','Esta conta não possui cadastro finalizado. Consulte o suporte para recuperar seu cadastro.');
 await firebaseSignOut(state.auth);
}
function loginErrorMessage(error){
  switch(error?.code){
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
    case 'auth/wrong-password':
    case 'auth/user-not-found': return 'E-mail ou senha incorretos. Confira os dados e tente novamente.';
    case 'auth/invalid-email': return 'Informe um endereço de e-mail válido.';
    case 'auth/user-disabled': return 'Esta conta foi desativada. Entre em contato com o suporte.';
    case 'auth/too-many-requests': return 'Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.';
    case 'auth/network-request-failed': return 'Não foi possível acessar a internet. Verifique sua conexão.';
    case 'auth/invalid-api-key':
    case 'auth/app-not-authorized':
    case 'auth/requests-from-referer-blocked':
    case 'auth/unauthorized-domain': return 'O serviço de autenticação está indisponível. Contate o suporte.';
    case 'auth/operation-not-allowed': return 'O login por e-mail não está habilitado. Contate o suporte.';
  }
  if(error?.name==='AbortError')return 'O sistema demorou a responder. Verifique sua conexão e tente novamente.';
  if(error?.httpStatus===401)return 'Sessão expirada. Entre novamente.';
  if(error?.httpStatus===403)return 'A conta não tem permissão para entrar. '+String(error.message||'');
  if(error?.httpStatus===404)return 'Não foi possível consultar o cadastro no sistema. Entre em contato com o suporte.';
  if(error?.httpStatus>=500)return 'O sistema está temporariamente indisponível. Tente novamente mais tarde.';
  if(error?.message==='Failed to fetch'||error?.name==='TypeError')return 'Não foi possível conectar ao sistema. Verifique sua internet.';
  return String(error?.message||'Não foi possível entrar. Tente novamente.');
}
async function routeAuthenticatedUser(){
  if(!state.user||state.signupInProgress||state.sessionClosing)return;
  // Login Firebase e observador de sessão podem chamar a validação simultaneamente.
  if(loginRoutingPromise)return loginRoutingPromise;
  if(state.sessionId && state.screen==='channels')return;
  const task=(async()=>{
    try{
      if(state.screen==='login') registrationMessage('login-message','Verificando sua conta no sistema...');
      const s=await api('/api/pending-registration/status');
      await routeRegistrationStatus(s);
      if(state.screen!=='login')registrationMessage('login-message','');
    }catch(e){
      status('Acesso indisponível');
      const message=loginErrorMessage(e);
      if(state.screen==='login') registrationMessage('login-message',message);
      else if(state.screen==='verify')registrationMessage('verify-message',message);
      else if(state.screen==='contribution')registrationMessage('contribution-message',message);
      console.error('[LOGIN] Falha ao validar conta:',e?.code||e?.httpStatus||e?.message);
      handleError(e);
    }
  })();
  loginRoutingPromise=task;
  try{return await task;}finally{if(loginRoutingPromise===task)loginRoutingPromise=null;}
}
async function showContributions(s){
 state.registrationStatus=s;state.selectedAccessPlan='';
 screen('contribution');$('contribution-checkout').hidden=true;$('contribution-checkout').replaceChildren();
 $('contribution-explanation').textContent=s.pending
   ? 'Para garantir a continuidade, a qualidade e a evolução do serviço, a ativação de contas é realizada mediante uma contribuição. Novos cadastros podem escolher um único teste de 24 horas, quando disponível.'
   : s.accessType==='trial'&&s.accessExpired
     ? 'Seu teste de 24 horas terminou e não pode ser renovado. Sua conta e canais permanecem salvos. Escolha um período de contribuição para continuar.'
     : 'Seu período de acesso terminou. Escolha uma contribuição para renovar; sua conta e canais permanecem salvos.';
 registrationMessage('contribution-message','Consultando as opções de acesso...');
 const plans=$('contribution-plans');plans.replaceChildren();$('contribution-continue').disabled=true;
 try{
  const policy=await loadRegistrationPolicy();
  const options=[];
  if(s.pending&&s.emailVerified&&s.paymentRequired&&s.paymentStatus!=='approved'&&policy.oneTimeTrialAvailable)
   options.push({id:'trial24h',label:'Teste gratuito de 24 horas (uma única vez)',amount:0});
  for(const p of (policy.plans||[]))if(p.enabled!==false&&p.id&&Number(p.amount)>0)options.push(p);
  options.forEach((p,i)=>{
   const label=document.createElement('label');label.className='access-plan';
   const radio=document.createElement('input');radio.type='radio';radio.name='access-plan';radio.value=p.id;radio.checked=i===0;
   const span=document.createElement('span');span.textContent=p.id==='trial24h'?p.label:`${p.label} — ${Number(p.amount).toLocaleString('pt-BR',{style:'currency',currency:policy.currency||'BRL'})}`;
   label.append(radio,span);plans.append(label);
   radio.onchange=()=>{state.selectedAccessPlan=p.id;$('contribution-continue').textContent=p.id==='trial24h'?'INICIAR TESTE DE 24 HORAS':'PAGAR COM MERCADO PAGO';};
  });
  if(options.length){const first=plans.querySelector('input');first.dispatchEvent(new Event('change'));$('contribution-continue').disabled=false;registrationMessage('contribution-message','');}
  else registrationMessage('contribution-message','Nenhuma opção de contribuição está disponível no momento.');
  state.paymentRef=s.paymentRef||state.paymentRef||'';
 }catch(e){registrationMessage('contribution-message',e.message);}
}
async function activateTrial(){
 if(!state.user||!state.registrationStatus?.pending||!state.registrationStatus.emailVerified||state.selectedAccessPlan!=='trial24h')throw Error('O teste não está disponível para esta conta.');
 const confirmed=await confirmModal('Teste de 24 horas','Esse teste pode ser ativado apenas uma vez por e-mail e começa imediatamente. Quando terminar, será necessária uma contribuição. Deseja iniciar?','INICIAR TESTE');
 if(!confirmed)return;
 const current=await api('/api/pending-registration/status');
 if(!current.pending||!current.emailVerified||!current.paymentRequired)throw Error('O teste não está disponível nesta conta.');
 $('contribution-continue').disabled=true;
 try{await finalizePending(current,true);toast('Seu teste gratuito de 24 horas está ativo.');}
 finally{$('contribution-continue').disabled=false;}
}
async function startContributionPayment(){
 if(!state.user||!state.selectedAccessPlan)throw Error('Selecione um período de acesso.');
 if(state.selectedAccessPlan==='trial24h'){await activateTrial();return;}
 const btn=$('contribution-continue');btn.disabled=true;
 registrationMessage('contribution-message','Preparando o pagamento seguro...');
 try{
  const result=await api('/api/access/payment/create',{method:'POST',body:{planId:state.selectedAccessPlan}});
  if(!/^https:\/\//i.test(result.checkoutUrl||''))throw Error('O sistema não retornou o endereço seguro de pagamento.');
  state.paymentRef=result.paymentRef||'';
  const area=$('contribution-checkout');area.replaceChildren();area.hidden=false;
  const p=document.createElement('p');p.textContent='Pagamento preparado. Abra o Mercado Pago e depois volte para verificar a aprovação.';
  const a=document.createElement('a');a.className='primary checkout-link';a.textContent='ABRIR MERCADO PAGO';a.href=result.checkoutUrl;a.target='_blank';a.rel='noopener noreferrer';
  area.append(p,a);registrationMessage('contribution-message','');
 }catch(e){registrationMessage('contribution-message',e.message);throw e;}
 finally{btn.disabled=false;}
}
async function checkContribution(){
 const btn=$('contribution-check');btn.disabled=true;
 try{
  // Uma liberação manual no painel pode ativar a conta antes de um pagamento.
  // Por isso, priorizar o estado atual da conta no servidor.
  let s=await api('/api/pending-registration/status');
  if(s.pending&&s.paymentStatus==='approved'){
   await finalizePending(s);toast('Conta ativada!');return;
  }
  if(!s.pending&&s.active){await routeRegistrationStatus(s);return;}
  if(state.paymentRef){
   const payment=await api(`/api/access/payment/status?paymentRef=${encodeURIComponent(state.paymentRef)}`);
   if(payment.approved){
    s=await api('/api/pending-registration/status');
    if(s.pending&&s.paymentStatus==='approved'){await finalizePending(s);toast('Conta ativada!');return;}
    if(!s.pending&&s.active){await routeRegistrationStatus(s);return;}
   }
  }
  if(s.pending&&s.paymentRequired){
   registrationMessage('contribution-message','A contribuição ainda não foi confirmada pelo sistema. Se já pagou, aguarde e confira novamente.');return;
  }
  await routeRegistrationStatus(s);
  registrationMessage('contribution-message','A liberação ainda não foi confirmada pelo sistema.');
 }finally{btn.disabled=false;}
}

async function openSession(force=false){
 const d=await api('/api/session/open',{method:'POST',body:{deviceId:state.deviceId,force}});
 if(!d.sessionId)throw new Error('O sistema não devolveu uma sessão válida.');
 state.sessionId=d.sessionId;
 state.sessionEnded=false;
 return d;
}
function stopConnection(){
 if(state.txGranted)sendWS({type:'stop_tx'});
 audio.abortEncoder();audio.stopReplay();audio.stopRx();clearInterval(state.txClock);clearTimeout(state.txStopTimer);
 state.holding=false;state.pendingTx=false;state.txGranted=false;state.txStopping=false;state.webAudioReady=false;
 updateTxUI();
 clearTimeout(state.reconnect);state.reconnect=null;state.wsReady=false;
 if(state.ws){const old=state.ws;state.ws=null;old.onclose=null;old.onmessage=null;try{old.close(1000,'Sessão encerrada');}catch{}}
}
async function endCurrentSession(reason='Você entrou com outro dispositivo.', title='Login em outro dispositivo'){
 if(state.sessionClosing||state.sessionEnded)return;
 state.sessionClosing=true;
 state.sessionEnded=true;
 state.sessionId='';
 stopConnection();
 state.selected=null;state.profile=null;state.channels=[];state.users=[];
 status('Sessão encerrada');
 screen('login');
 $('login-message').textContent='A sessão anterior foi encerrada. Entre novamente para continuar.';
 // Retira as credenciais locais, sem excluir a conta do Firebase.
 try{if(state.auth)await firebaseSignOut(state.auth);}catch(e){console.warn('[SESSION] Não foi possível limpar login:',e?.message);}
 state.user=null;
 state.sessionClosing=false;
 modal(title, area=>{
  const box=document.createElement('div');box.className='modal-stack';
  const p=document.createElement('p');
  p.textContent=reason;
  const desc=document.createElement('p');
  desc.textContent='Por segurança, esta sessão foi desconectada. Toque em Sair para voltar à tela de login.';
  const btn=document.createElement('button');btn.type='button';btn.className='primary';btn.textContent='Sair';btn.onclick=()=>{closeModal();$('login-email').focus();};
  box.append(p,desc,btn);area.append(box);
 });
}
async function initAccount(){
 if(!state.user||state.sessionClosing)return;
 state.sessionEnded=false;
 try{await openSession(false);}catch(error){
  if(error.code==='SESSION_TAKEN'){
   const accepted=await confirmModal('Conta em outro dispositivo','Sua conta já está conectada em outro aparelho. Deseja entrar aqui e encerrar a sessão anterior?','Entrar neste dispositivo');
   if(!accepted){
    // Cancelar deve manter intacta a sessão do aparelho antigo.
    await logout();
    $('login-message').textContent='A sessão do outro dispositivo foi mantida.';
    return;
   }
   await openSession(true);
  }else{
   status('Conta sem acesso');screen('login');
   if(['PAYMENT_REQUIRED','REGISTRATION_PAYMENT_REQUIRED','ACCESS_EXPIRED','ACCOUNT_NOT_ACTIVATED'].includes(error.code)||error.httpStatus===402){
    // O token de pagamento nunca é gerado no navegador.
    menu('Contribuição necessária',[{label:'Minha Conta e Renovação',fn:openRenewal},{label:'Cancelar',fn:()=>{}}]);
   }
   throw error;
  }
 }
 if(state.sessionEnded||!state.sessionId)return;
 const me=await api('/api/users/me');
 if(state.sessionEnded)return;
 state.profile=me;updateProfile();await loadChannels();
 if(state.sessionEnded)return;
 screen('channels');startWS();
}
function updateProfile(){const p=state.profile||{};$('my-username').textContent=p.username||state.user?.displayName||'Minha conta';$('my-email').textContent=state.user?.email||'';$('my-avatar').innerHTML=avatarMarkup(p.avatar,p.username);}
async function loadChannels(){const result=await api('/api/channels/mine');state.channels=Array.isArray(result.channels)?result.channels:[];state.defaultChannelId=result.defaultChannelId||null;if(state.selected)state.selected=state.channels.find(c=>c.id===state.selected.id)||null;renderChannels();if(state.selected)updatePTT();}
function channelHTML(c){const flagged=c.removed?'Removido':c.blocked?'Bloqueado':c.enabled===false?'Desativado':c.type==='private'?'Privado':'Público';return `<button class="channel-card-main" data-open="${escapeHTML(c.id)}"><span class="avatar-circle" data-avatar="${escapeHTML(c.id)}">${avatarMarkup(c.avatar,c.name)}</span><span class="channel-info"><span class="channel-name">${escapeHTML(c.name)}</span><span class="channel-id">ID: ${escapeHTML(c.id)} ${state.defaultChannelId===c.id?'• Padrão':''}</span><span class="channel-type">${flagged}</span><span class="channel-description">${escapeHTML(c.description||'')}</span></span></button><button class="channel-menu" aria-label="Opções do canal" data-menu="${escapeHTML(c.id)}">⋮</button>`;}
function renderChannels(){const list=$('channels-list');list.replaceChildren();if(!state.channels.length){list.innerHTML='<p class="empty">Nenhum canal na lista. Adicione um canal público ou crie o seu.</p>';return;}
 for(const c of state.channels){const card=document.createElement('div');card.className='channel-card';card.innerHTML=channelHTML(c);const main=card.querySelector('[data-open]');const avatar=card.querySelector('[data-avatar]');main.onclick=e=>{if(main.dataset.preventClick==='yes'){main.dataset.preventClick='no';return;}if(e.target.closest('[data-avatar]')){channelMenu(c);return;}openChannel(c).catch(handleError);};card.querySelector('[data-menu]').onclick=()=>channelMenu(c);
 let press=null,longPress=false;main.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'&&e.button!==0)return;longPress=false;press=setTimeout(()=>{longPress=true;main.dataset.preventClick='yes';channelMenu(c);},570);});for(const ev of ['pointerup','pointerleave','pointercancel'])main.addEventListener(ev,()=>clearTimeout(press));main.addEventListener('contextmenu',e=>{e.preventDefault();clearTimeout(press);if(!longPress)channelMenu(c);});list.append(card);
 }}
function sendWS(data){if(state.ws?.readyState===WebSocket.OPEN&&state.wsReady){try{state.ws.send(JSON.stringify(data))}catch{}}}
function startWS(){
 if(state.sessionEnded||!state.user||!state.sessionId)return;
 stopConnection();
 state.wsReady=false;state.webAudioReady=false;updateTxUI();status('Conectando');
 const socket=new WebSocket(cfg.wsUrl);
 state.ws=socket;socket.binaryType='arraybuffer';
 socket.onopen=async()=>{
  try{
   if(!state.user||state.ws!==socket||state.sessionEnded)return;
   socket.send(JSON.stringify({
    type:'identify',token:await state.user.getIdToken(),
    sessionId:state.sessionId,deviceId:state.deviceId,name:state.profile?.username||'Usuário'
   }));
  }catch(e){handleError(e);socket.close();}
 };
 socket.onmessage=e=>{
  if(state.sessionEnded)return;
  if(e.data instanceof ArrayBuffer){
   if(audio.rxChannelId && lastMessage.recording?.channelId===String(audio.rxChannelId))lastMessage.append(e.data);
   audio.feedPacket(e.data);return;
  }
  if(typeof e.data!=='string')return;
  let data;try{data=JSON.parse(e.data);}catch{return;}
  handleSignal(data);
 };
 socket.onclose=e=>{
  if(state.ws!==socket||state.sessionEnded)return;
  state.ws=null;state.wsReady=false;
  audio.abortEncoder();audio.stopRx();state.rxTransmission=null;state.usersChannelId=null;state.txGranted=false;state.pendingTx=false;state.webAudioReady=false;updateTxUI();renderChannelPresence();updateCrossChannelBanner();
  // O servidor usa 4001 ao substituir ou invalidar uma sessão.
  if(e.code===4001 || /session replaced|session invalid/i.test(e.reason||'')){
   endCurrentSession('Você entrou com outro dispositivo ou sua sessão foi encerrada.').catch(handleError);
   return;
  }
  status(navigator.onLine?'Reconectando':'Sem internet');
  if(state.user&&state.sessionId&&state.screen!=='login'){
   state.reconnect=setTimeout(()=>startWS(),4000);
  }
 };
 socket.onerror=()=>status('Conexão indisponível');
}
async function checkCurrentSession(){
 if(state.checkingSession||state.sessionEnded||!state.user||!state.sessionId)return;
 state.checkingSession=true;
 try{
  // Nunca usa force: o aparelho antigo jamais pode expulsar a sessão atual.
  const originalId=state.sessionId;
  const response=await api('/api/session/open',{method:'POST',body:{deviceId:state.deviceId,force:false}});
  if(!state.sessionEnded&&response.sessionId!==originalId){
   await endCurrentSession('A sessão desta conta foi alterada em outro dispositivo.');
  }
 }catch(e){
  if(e.code==='SESSION_TAKEN'||e.httpStatus===409){
   await endCurrentSession('Você entrou com outro dispositivo.');
  }else if(e.httpStatus===401){
   await endCurrentSession('Sua sessão expirou. Entre novamente para continuar.');
  }else{
   console.warn('[SESSION] Não foi possível verificar a sessão:',e.message);
  }
 }finally{state.checkingSession=false;}
}
function handleSignal(data){switch(data.type){
 case 'init':state.wsReady=true;status('Conectado');if(data.channels) {state.channels=data.channels;state.defaultChannelId=data.defaultChannelId;renderChannels();}state.users=data.clients||[];renderUsers();if(state.selected)sendWS({type:'select_channel',channelId:state.selected.id});sendWS({type:'sync_rx'});renderChannelPresence();updateCrossChannelBanner();audio.initEncoder().then(()=>{state.webAudioReady=true;updateTxUI();$('ptt-note').textContent='Pronto para transmitir';}).catch(e=>{state.webAudioReady=false;updateTxUI();$('ptt-note').textContent='Transmissão indisponível. Confira o áudio e tente novamente.';});updateTxUI();break;
 case 'tx_granted':txGranted(data);break;
 case 'channel_state':case 'channels_updated':case 'channels_state':
  if(Array.isArray(data.channels)){state.channels=data.channels;renderChannels();updateCrossChannelBanner();}
  // O servidor pode informar uma transmissão já ativa durante a reconexão.
  // Não fabricamos um start_tx: aguardamos o evento de sincronização real.
  break;
 case 'channel_selected':break;
 case 'user_list':case 'clients':{
  const channelId=String(data.channelId||'');
  if(state.selected&&channelId===String(state.selected.id)){
   state.users=Array.isArray(data.clients||data.users)?data.clients||data.users:[];
   state.usersChannelId=channelId;
   renderUsers();renderChannelPresence();
  }
  break;
 }
 case 'start_tx':{
  if(!data.channelId)break;
  audio.stopReplay();state.replayActive=false;updateReplayUI();
  // A captura e local: um novo TX substitui imediatamente a ultima mensagem.
  lastMessage.begin(state.user?.uid,data.channelId,data.name||'Usuário');
  state.txUser=data.name||'Usuário';
  state.rxTransmission={channelId:String(data.channelId),channelName:String(data.channelName||''),speaker:state.txUser,from:String(data.from||'')};
  $('rx-status').textContent='Recebendo';state.lastRxAt=Date.now();
  updateCrossChannelBanner();renderChannelPresence();
  audio.beginRx(data.channelId).catch(handleError);break;
 }
 case 'stop_tx':
  if(!data.channelId||String(data.channelId)===String(lastMessage.recording?.channelId))lastMessage.end();
  if(!data.channelId||String(data.channelId)===String(audio.rxChannelId)){
   audio.stopRx();state.txUser='';state.rxTransmission=null;
   $('rx-status').textContent='Aguardando';updateCrossChannelBanner();renderChannelPresence();
  }
  break;
 case 'session_invalid':endCurrentSession('Sua sessão não está mais válida. Entre novamente para continuar.','Sessão encerrada').catch(handleError);break;
 case 'session_revoked':endCurrentSession(data.reason||'Você entrou com outro dispositivo.',data.code==='GLOBAL_BAN'||data.code==='PAYMENT_REQUIRED'?'Acesso encerrado':'Login em outro dispositivo').catch(handleError);break;
 case 'channel_removed':toast(data.message||'Canal removido');loadChannels().catch(handleError);break;
 case 'tx_denied':if(state.txGranted||state.pendingTx){audio.abortEncoder();finishTx();}toast(data.message||'Operação não permitida');break;
 case 'channel_select_denied':toast(data.message||'Operação não permitida');break;
 case 'user_update':if(data.id===state.profile?.uid){state.profile.username=data.name||state.profile.username;state.profile.avatar=data.avatar||'';updateProfile();}break;
 }}
async function openChannel(c){if(c.removed||c.blocked||c.enabled===false){toast('Este canal está indisponível. Confira suas opções.');return;}state.selected=c;
 // Lista de presenca recebida para outro canal nao deve ser reaproveitada.
 state.users=[];state.usersChannelId=null;
 updatePTT();screen('ptt');
 // A abertura ocorre a partir de um gesto do usuário: libera o áudio no iOS.
 audio.stopReplay();state.replayActive=false;updateReplayUI();
 audio.ensurePlayback().then(()=>setAudioReadyUI(true)).catch(e=>{setAudioReadyUI(false);$('ptt-note').textContent='Toque em 🔊 para habilitar a recepção de áudio.';console.warn('[WEB AUDIO]',e?.message);});
 // Se o RX ja e deste canal, nao interrompa a fala ao tocar no banner.
 if(String(audio.rxChannelId||'')!==String(c.id))audio.stopRx();
 updateTxUI();sendWS({type:'select_channel',channelId:c.id});sendWS({type:'sync_rx'});}
function updatePTT(){const c=state.selected;if(!c)return;$('ptt-title').textContent=c.name;$('ptt-channel-name').textContent=c.name;$('ptt-channel-avatar').innerHTML=avatarMarkup(c.avatar,c.name);$('ptt-type').textContent=c.type==='private'?'PRIVADO':'PÚBLICO';renderChannelPresence();updateCrossChannelBanner();}
function renderUsers(){const list=$('users-list');list.replaceChildren();const users=state.users||[];renderChannelPresence();if(!users.length){list.innerHTML='<p class="empty">Nenhum usuário informado pelo servidor.</p>';return;}for(const u of users){const row=document.createElement('div');row.className='channel-card';row.innerHTML=`<span class="avatar-circle">${avatarMarkup(u.avatar,u.name)}</span><span class="channel-info"><span class="channel-name">${escapeHTML(u.name||'Usuário')}</span><span class="channel-id">${u.isOwner?'Administrador':u.isModerator?'Moderador':'Usuário'} ${u.isInChannel?'• Neste canal':''}</span></span>`;list.append(row);}}
function channelMenu(channel){const c=state.channels.find(c=>c.id===channel.id)||channel;const owner=c.ownerUid===state.profile?.uid;const actions=[
 {label:'Entrar no canal',fn:()=>openChannel(c)},
 {label:'Informações do canal',fn:()=>infoChannel(c)},
 {label:state.defaultChannelId===c.id?'Remover canal padrão':'Definir canal padrão',fn:()=>perform(async()=>{await api('/api/channels/set-default',{method:'POST',body:{channelId:state.defaultChannelId===c.id?'':c.id}});await loadChannels();toast('Canal padrão atualizado');})},
 {label:c.enabled===false?'Ativar canal':'Desativar canal',fn:()=>perform(async()=>{await api('/api/channels/set-enabled',{method:'POST',body:{channelId:c.id,enabled:c.enabled===false}});await loadChannels();})},
 {label:'Compartilhar convite do canal',fn:()=>shareChannel(c)} ];
 if(owner){actions.push({label:'Trocar foto do canal',fn:()=>chooseImage({type:'channel',channelId:c.id})},{label:'Alterar nome e descrição',fn:()=>editChannel(c)},{label:'Excluir canal definitivamente',danger:true,fn:()=>deleteChannel(c)});}else actions.push({label:'Remover da minha lista',danger:true,fn:()=>removeChannel(c)});
 menu(c.name,actions);}
function infoChannel(c){modal('Informações do canal',`<div class="modal-stack"><p><b>Nome:</b> ${escapeHTML(c.name)}<br><b>ID:</b> ${escapeHTML(c.id)}<br><b>Tipo:</b> ${c.type==='private'?'Privado':'Público'}<br><b>Descrição:</b> ${escapeHTML(c.description||'Sem descrição')}</p><button id="info-share" class="outline">Compartilhar canal</button></div>`);$('info-share').onclick=()=>shareChannel(c);}
async function perform(task){try{await task();}catch(e){handleError(e)}}
async function editChannel(c){const values=await promptModal('Editar canal',[{label:'Nome do canal',name:'name',value:c.name,maxLength:40,required:true},{label:'Descrição',name:'description',value:c.description,maxLength:200,type:'textarea'}]);if(!values)return;await perform(async()=>{await api('/api/channels/profile',{method:'POST',body:{channelId:c.id,...values}});await loadChannels();toast('Canal atualizado');});}
async function deleteChannel(c){if(!await confirmModal('Excluir canal',`Excluir definitivamente o canal ${c.name}? Esta ação também afeta seus participantes.`, 'Excluir canal'))return;await perform(async()=>{await api('/api/channels/delete',{method:'POST',body:{channelId:c.id}});state.selected=null;await loadChannels();toast('Canal excluído');});}
async function removeChannel(c){if(!await confirmModal('Remover canal',`Remover ${c.name} da sua lista?`,'Remover'))return;await perform(async()=>{await api('/api/channels/remove',{method:'POST',body:{channelId:c.id}});state.selected=null;await loadChannels();toast('Canal removido da lista');});}
function profileMenu(){menu('Minha conta',[{label:'Trocar foto do perfil',fn:()=>chooseImage({type:'user'})},{label:'Alterar nome de usuário',fn:async()=>{const v=await promptModal('Alterar nome',[{label:'Novo nome',name:'username',value:state.profile?.username,maxLength:32,required:true}]);if(!v)return;await perform(async()=>{await api('/api/users/username',{method:'POST',body:v});state.profile.username=v.username;updateProfile();toast('Nome atualizado');});}},{label:'Minha Conta e Renovação',fn:openRenewal},{label:'Atualizar canais',fn:()=>perform(loadChannels)},{label:'Desconectar',danger:true,fn:confirmDisconnect}]);}
async function logout(){
 stopConnection();state.sessionId='';state.sessionEnded=true;
 state.profile=null;state.channels=[];state.selected=null;state.users=[];state.rxTransmission=null;state.usersChannelId=null;
 try{if(state.auth)await firebaseSignOut(state.auth);}catch(e){console.warn('[SESSION] Sair:',e?.message);}
 state.user=null;status('Desconectado');screen('login');
}
// Mesma API e opcoes do AccountStatusActivity do APK Android.
let accountStatus=null;
const lastPaymentKey=()=>`zlinktalk-web-last-payment-${state.user?.uid||'unknown'}`;
const brCurrency=n=>Number(n||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
function brDate(t){const ms=Number(t||0);return ms>0?new Date(ms).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}):'Não informado';}
function remainingTime(t){const d=Number(t||0)-Date.now();if(!Number(t)||d<=0)return 'Encerrado';const days=Math.floor(d/86400000);const hours=Math.floor(d%86400000/3600000);return days>0?`${days} dia(s) e ${hours} hora(s)`:`${hours} hora(s) e ${Math.floor(d%3600000/60000)} minuto(s)`;}
function accountDetail(label,value){return `<div class="account-detail"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong></div>`;}
function accountSection(title,html){return `<section class="account-section"><h3>${escapeHTML(title)}</h3>${html}</section>`;}
function renderAccountStatus(s){
 accountStatus=s;
 const result=$('account-details');if(!result)return;
 const types={trial:'Degustação',paid:s.lastAdminGrantAt>0&&!s.lastPaymentAt?'Liberado pela administração':'Pago / contribuição',free:'Gratuito',legacy:'Legado'};
 const type=types[s.accessType]||'Conta Z-Link Talk';
 const label=!s.active?'Contribuição necessária — acesso vencido':s.trialActive?'Degustação ativa':s.paidActive?'Pagamento ativo':'Ativo';
 let markup=accountSection('Situação do acesso',[
  accountDetail('Usuário',s.username||state.profile?.username||'—'),
  accountDetail('E-mail',state.user?.email||'—'),
  accountDetail('Tipo da conta',type),
  accountDetail('Estado',label),
  accountDetail('Contribuição exigida',s.contributionRequired?'Sim':'Não')].join(''));
 if(s.trialStartedAt||s.trialEndsAt){
  markup+=accountSection('Período de degustação',[
   accountDetail('Início',brDate(s.trialStartedAt)),accountDetail('Término',brDate(s.trialEndsAt)),
   accountDetail('Situação',s.trialActive?'Em andamento':'Encerrado')].join(''));
 }
 if(s.accessExpiresAt||s.nextExpiration){
  markup+=accountSection('Validade de acesso',[
   accountDetail('Vencimento',brDate(s.nextExpiration||s.accessExpiresAt)),
   accountDetail('Tempo restante',remainingTime(s.nextExpiration||s.accessExpiresAt))].join(''));
 }
 if(s.lastPaymentAt){
  markup+=accountSection('Última contribuição registrada',[
   accountDetail('Data',brDate(s.lastPaymentAt)),
   accountDetail('Plano',s.lastPaymentPlan||'Não informado'),
   s.lastPaymentAmount>0?accountDetail('Valor',brCurrency(s.lastPaymentAmount)):''].join(''));
 }
 if(s.lastAdminGrantAt){markup+=accountSection('Autorização administrativa',accountDetail('Última liberação',brDate(s.lastAdminGrantAt)));}
 markup+=accountSection('Sobre a renovação',`<p>${s.paymentEligible?'Você pode antecipar sua contribuição. O tempo de acesso restante será preservado e o novo período acrescentado após o vencimento atual. Pagamento pelo Mercado Pago, sem renovação automática.':'Esta conta não exige contribuição neste momento. A administração controla a elegibilidade para renovação.'}</p>`);
 result.innerHTML=markup;
 $('account-renew').disabled=!s.paymentEligible;
 $('account-status-badge').textContent=label;
 $('account-status-badge').classList.toggle('account-expired',!s.active);
}
async function refreshAccountStatus(showToast=false){
 const feedback=$('account-feedback');
 if(!state.user)return;
 feedback.textContent='Consultando a situação da conta...';
 $('account-refresh').disabled=true;
 try{
  const s=await api('/api/access/status');
  renderAccountStatus(s);
  feedback.textContent='Situação consultada no sistema.';
  if(showToast)toast('Situação da conta atualizada.');
 }catch(error){feedback.textContent='Não foi possível atualizar a conta: '+(error?.message||'Falha de conexão');if(showToast)handleError(error);}
 finally{$('account-refresh').disabled=false;}
}
async function openRenewal(){
 if(!state.user){toast('Entre na sua conta para consultar o acesso.');return;}
 screen('account');
 await refreshAccountStatus();
}
async function chooseAccountPlan(){
 if(!accountStatus?.paymentEligible){toast('Esta conta não está habilitada para novas contribuições.');return;}
 const policy=await loadRegistrationPolicy();
 const plans=(policy.plans||[]).filter(p=>p.enabled!==false&&p.id&&Number(p.amount)>0);
 if(!policy.mercadoPagoConfigured||!plans.length){toast('O pagamento está temporariamente indisponível.');return;}
 modal('Antecipar contribuição',area=>{
  const wrap=document.createElement('div');wrap.className='modal-stack';
  const intro=document.createElement('p');intro.textContent='Escolha o período de acesso. Os dias restantes serão preservados.';wrap.append(intro);
  const group=document.createElement('div');group.className='contribution-plans';
  plans.forEach((plan,i)=>{
   const label=document.createElement('label');label.className='access-plan';
   const input=document.createElement('input');input.type='radio';input.name='account-plan';input.value=plan.id;input.checked=i===0;
   const text=document.createElement('span');text.textContent=`${plan.label} — ${brCurrency(plan.amount)}`;
   label.append(input,text);group.append(label);
  });wrap.append(group);
  const next=document.createElement('button');next.className='primary';next.textContent='CONTINUAR';next.onclick=async()=>{
   const id=group.querySelector('input:checked')?.value;if(!id)return;
   next.disabled=true;next.textContent='Preparando pagamento...';
   try{
    const order=await api('/api/access/payment/create',{method:'POST',body:{planId:id}});
    if(!/^https:\/\//i.test(order.checkoutUrl||''))throw Error('O sistema não disponibilizou o pagamento seguro.');
    if(order.paymentRef)localStorage.setItem(lastPaymentKey(),order.paymentRef);
    modal('Pagamento pelo Mercado Pago',node=>{
     const d=document.createElement('div');d.className='modal-stack';
     const p=document.createElement('p');p.textContent='O pagamento foi preparado. Abra o Mercado Pago e volte ao Z-Link Talk para conferir a aprovação.';
     const link=document.createElement('a');link.href=order.checkoutUrl;link.target='_blank';link.rel='noopener noreferrer';link.className='primary checkout-link';link.textContent='ABRIR MERCADO PAGO';
     const check=document.createElement('button');check.className='outline';check.textContent='VERIFICAR PAGAMENTO';check.onclick=()=>{closeModal();checkAccountPayment().catch(handleError);};
     d.append(p,link,check);node.append(d);
    });
   }catch(error){next.disabled=false;next.textContent='CONTINUAR';handleError(error);}
  };wrap.append(next);area.append(wrap);
 });
}
async function checkAccountPayment(){
 const ref=localStorage.getItem(lastPaymentKey())||'';
 if(!ref){
  const ok=await confirmModal('Verificar último pagamento','Não há uma referência de pagamento salva neste aparelho. Isso pode acontecer quando a contribuição foi feita em outro dispositivo. Deseja atualizar a situação da conta?','ATUALIZAR CONTA');
  if(ok)await refreshAccountStatus(true);
  return;
 }
 $('account-feedback').textContent='Verificando o último pagamento...';
 try{
  const info=await api(`/api/access/payment/status?paymentRef=${encodeURIComponent(ref)}`);
  if(info.approved){toast('Pagamento aprovado!');await refreshAccountStatus();return;}
  const statusMap={pending:'Pagamento aguardando confirmação.',in_process:'Pagamento em processamento.',rejected:'Pagamento não aprovado.',cancelled:'Pagamento cancelado.',canceled:'Pagamento cancelado.'};
  const result=statusMap[String(info.status).toLowerCase()]||`Situação do pagamento: ${info.status||'Não informada'}.`;
  $('account-feedback').textContent=result;toast(result);
 }catch(error){$('account-feedback').textContent=error?.message||'Falha ao verificar o pagamento.';handleError(error);}
}
function accountSupport(){
 menu('Suporte e contato',[
  {label:'E-mail — dinizrfoficial@gmail.com',fn:()=>{location.href='mailto:dinizrfoficial@gmail.com';}},
  {label:'WhatsApp — conversar com o suporte',fn:()=>{window.open('https://wa.me/5533999077551?text='+encodeURIComponent('Olá! Preciso de suporte com o Z-Link Talk Universal.'),'_blank','noopener,noreferrer');}},
  {label:'Voltar',fn:()=>{}}
 ]);
}
// Convite usa a rota publica instalada em app.zlinktalk.com.br e conserva o ID de oito digitos.
function buildChannelInvitation(channel){
 const id=String(channel?.id??'');
 if(!/^\d{8}$/.test(id))throw Error('ID do canal inválido para compartilhar.');
 const url=`https://app.zlinktalk.com.br/invite/?channel=${encodeURIComponent(id)}`;
 return `Você foi convidado para entrar no canal "${String(channel?.name||'Canal')}" no app Z-Link Talk.\n\n${url}`;
}
async function shareChannel(channel){
 const text=buildChannelInvitation(channel);
 try{
  // Enviamos texto unico para evitar que mensageiros dupliquem o endereco.
  if(navigator.share){await navigator.share({text});return;}
  if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);toast('Convite copiado');return;}
  await promptModal('Compartilhar convite',[{label:'Mensagem de convite',name:'invite',type:'textarea',value:text}],'Fechar');
 }catch(e){if(e?.name!=='AbortError')handleError(e);}
}
function chooseImage(target){state.uploadTarget=target;$('avatar-file').value='';$('avatar-file').click();}
async function compressImage(file){if(!/^image\/(jpeg|png|webp)$/.test(file.type))throw Error('Escolha uma imagem JPG, PNG ou WebP.');if(file.size>18*1024*1024)throw Error('Imagem muito grande.');const bm=await createImageBitmap(file);try{for(const w of [360,280,220,170,140,110]){const scale=Math.min(1,w/Math.max(bm.width,bm.height));const cv=document.createElement('canvas');cv.width=Math.max(1,Math.round(bm.width*scale));cv.height=Math.max(1,Math.round(bm.height*scale));cv.getContext('2d').drawImage(bm,0,0,cv.width,cv.height);for(const q of [.81,.68,.55]){const encoded=cv.toDataURL('image/jpeg',q);if(encoded.length<77000)return encoded;}}throw Error('Não foi possível reduzir a foto para o limite de tamanho.');}finally{bm.close?.();}}
async function saveImage(file){const target=state.uploadTarget;if(!file||!target)return;const avatar=await compressImage(file);if(target.type==='create'){state.createAvatar=avatar;$('create-avatar-preview').innerHTML=`<img src="${avatar}" alt="Imagem do novo canal">`;toast('Imagem preparada');return;}if(target.type==='user'){await api('/api/users/avatar',{method:'POST',body:{avatar}});state.profile.avatar=avatar;updateProfile();toast('Foto de perfil atualizada');return;}if(target.type==='channel'){await api('/api/channels/avatar',{method:'POST',body:{channelId:target.channelId,avatar}});await loadChannels();toast('Foto do canal atualizada');}}
async function searchChannels(all=false,more=false){const q=$('channel-search').value.trim();if(!all&&!more&&q.length<2){toast('Digite pelo menos 2 caracteres');return;}if(!more){queryOffset=0;lastSearchQuery=all?'':q;$('search-results').replaceChildren();}const url=all||!lastSearchQuery?`/api/channels/public?offset=${queryOffset}`:`/api/channels/search?q=${encodeURIComponent(lastSearchQuery)}&offset=${queryOffset}`;const result=await api(url);const root=$('search-results');for(const c of result.channels||[]){const row=document.createElement('div');row.className='result-row';row.innerHTML=`<span class="avatar-circle">${avatarMarkup(c.avatar,c.name)}</span><span class="grow"><b>${escapeHTML(c.name)}</b><small>ID: ${escapeHTML(c.id)} • ${c.memberCount??0} inscrito(s)</small></span><button ${c.alreadyAdded?'disabled':''}>${c.alreadyAdded?'Adicionado':'Adicionar'}</button>`;row.querySelector('button').onclick=()=>addChannel(c.id);root.append(row);}queryOffset=result.nextOffset||0;queryHasMore=!!result.hasMore;root.querySelector('[data-more]')?.remove();if(result.hasMore){const b=document.createElement('button');b.textContent='Carregar mais';b.className='outline';b.dataset.more='yes';b.onclick=()=>perform(()=>searchChannels(false,true));root.append(b);}if(!root.children.length)root.innerHTML='<p class="empty">Nenhum canal encontrado.</p>';}
async function addChannel(id){if(!/^\d{8}$/.test(String(id)))throw Error('O ID deve conter 8 dígitos.');await api('/api/channels/add',{method:'POST',body:{channelId:id}});await loadChannels();toast('Canal adicionado');screen('channels');}
function wire(){
 setupSystemBack();
 $('modal-close').onclick=closeModal;$('modal').onclick=e=>{if(e.target===$('modal'))closeModal();};
 document.addEventListener('keydown',e=>{if(e.key==='Escape'||e.key==='BrowserBack'){e.preventDefault();goBack();}});
 $('login-form').onsubmit=async e=>{
  e.preventDefault();
  const b=$('login-submit');
  if(!state.auth){registrationMessage('login-message','O acesso está temporariamente indisponível. Verifique sua conexão e tente novamente.');return;}
  b.disabled=true;
  const original=b.textContent;
  b.textContent='AGUARDE...';
  registrationMessage('login-message','Validando e-mail e senha...');
  try{
    const result=await signInWithEmailAndPassword(state.auth,$('login-email').value.trim(),$('login-password').value);
    state.user=result.user;
    $('login-password').value='';
    registrationMessage('login-message','Verificando sua conta no sistema...');
    // Também valida quando a autenticação não dispara um novo onAuthStateChanged.
    await routeAuthenticatedUser();
  }catch(error){
    registrationMessage('login-message',loginErrorMessage(error));
    console.warn('[LOGIN] Firebase:',error?.code||error?.name||'falha');
  }finally{b.disabled=false;b.textContent=original;}
 };
 $('open-register').onclick=()=>openRegistration().catch(handleError);
 $('register-back').onclick=goBack;
 $('register-form').onsubmit=async e=>{e.preventDefault();const b=$('register-submit');b.disabled=true;registrationMessage('register-message','Validando dados do cadastro...');
  try{await createAccountFromForm();}catch(error){const hints={'auth/email-already-in-use':'Este e-mail já está cadastrado.','auth/weak-password':'Escolha uma senha mais forte.','auth/invalid-email':'E-mail inválido.','auth/network-request-failed':'Sem conexão com o Firebase. Verifique sua internet.'};registrationMessage('register-message',hints[error.code]||error.message);console.warn('[REGISTER]',error.code||error.message);}finally{if(state.screen==='register')b.disabled=false;}
 };
 $('register-retry').onclick=()=>retryRegistration().catch(e=>registrationMessage('register-message',e.message));
 $('verify-check').onclick=()=>checkEmailVerification().catch(e=>registrationMessage('verify-message',e.message));
 $('verify-resend').onclick=async()=>{const btn=$('verify-resend');btn.disabled=true;
  try{await sendEmailVerification(state.auth.currentUser);registrationMessage('verify-message','Novo e-mail de confirmação solicitado. Confira também a caixa de spam.');}
  catch(e){registrationMessage('verify-message',e.code==='auth/too-many-requests'?'Muitos pedidos. Aguarde antes de tentar novamente.':'Não foi possível reenviar o e-mail: '+e.message);}finally{btn.disabled=false;}
 };
 $('verify-logout').onclick=()=>logout().catch(handleError);
 $('contribution-continue').onclick=()=>startContributionPayment().catch(handleError);
 $('contribution-check').onclick=()=>checkContribution().catch(e=>registrationMessage('contribution-message',e.message));
 $('contribution-logout').onclick=()=>logout().catch(handleError);
 $('reset-password').onclick=async()=>{if(!state.auth){toast('Configure o Firebase primeiro.');return;}const email=$('login-email').value.trim();if(!email){toast('Informe seu e-mail acima.');return;}try{await sendPasswordResetEmail(state.auth,email);toast('Se a conta estiver apta, o e-mail será enviado.');}catch{toast('Verifique o e-mail e tente novamente.');}};
 $('account-back').onclick=goBack;
 $('account-renew').onclick=()=>chooseAccountPlan().catch(handleError);
 $('account-refresh').onclick=()=>refreshAccountStatus(true).catch(handleError);
 $('account-check-payment').onclick=()=>checkAccountPayment().catch(handleError);
 $('account-support').onclick=accountSupport;
 $('profile-more').onclick=pttScreenMenu;$('my-avatar-btn').onclick=profileMenu;
 $('add-channel-btn').onclick=()=>screen('search');$('create-channel-btn').onclick=()=>{state.createAvatar='';$('create-form').reset();$('create-avatar-preview').textContent='♟';screen('create');};
 document.querySelectorAll('[data-back]').forEach(b=>b.onclick=goBack);
 $('create-avatar-button').onclick=()=>chooseImage({type:'create'});$('avatar-file').onchange=e=>perform(()=>saveImage(e.target.files?.[0]));
 $('create-form').onsubmit=e=>{e.preventDefault();perform(async()=>{const form=e.target;const name=$('create-name').value.trim();if(name.length<3)throw Error('Nome com pelo menos 3 caracteres');const data=await api('/api/channels/create',{method:'POST',body:{name,description:$('create-description').value.trim(),type:form.querySelector('input[name="type"]:checked').value,avatar:state.createAvatar}});await loadChannels();screen('channels');toast(`Canal ${data.channel?.name||name} criado!`);});};
 $('channel-search-btn').onclick=()=>perform(()=>searchChannels(false));$('channel-all-btn').onclick=()=>perform(()=>searchChannels(true));$('channel-add-id').onclick=()=>perform(()=>addChannel($('channel-id').value.trim()));
 // Ajuste de tamanho sem acoplar a largura do PTT ao tipo de aparelho.
 const pttHost=document.querySelector('#ptt-screen .ptt-control');
 if(typeof ResizeObserver!=='undefined'&&pttHost){new ResizeObserver(scheduleResizePTT).observe(pttHost);}
 window.addEventListener('resize',scheduleResizePTT,{passive:true});
 window.addEventListener('orientationchange',scheduleResizePTT,{passive:true});
 window.visualViewport?.addEventListener('resize',scheduleResizePTT,{passive:true});
 $('ptt-other-tx').addEventListener('click',openTransmittingChannel);
 $('ptt-other-tx').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openTransmittingChannel();}});
 $('ptt-back').onclick=goBack;$('ptt-users').onclick=()=>{renderUsers();screen('users');};$('ptt-more').onclick=pttScreenMenu;$('ptt-last').onclick=()=>playLastMessage().catch(handleError);
 $('ptt-channel-avatar').onclick=()=>{if(state.selected)channelMenu(state.selected);};
 $('ptt-channel-avatar').onkeydown=e=>{if((e.key==='Enter'||e.key===' ')&&state.selected){e.preventDefault();channelMenu(state.selected);}};
 const ptt=$('ptt-button');ptt.style.touchAction='none';
 ptt.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'&&e.button!==0)return;e.preventDefault();ptt.setPointerCapture?.(e.pointerId);beginTx().catch(handleError);});
 for(const evt of ['pointerup','pointercancel','lostpointercapture'])ptt.addEventListener(evt,()=>stopTxNow());
 ptt.addEventListener('contextmenu',e=>e.preventDefault());
 // Teclado físico: barra de espaço mantém TX apenas enquanto pressionada.
 document.addEventListener('keydown',e=>{if(e.code==='Space'&&state.screen==='ptt'&&!e.repeat&& !['INPUT','TEXTAREA','BUTTON'].includes(document.activeElement?.tagName)){e.preventDefault();beginTx().catch(handleError);}});
 document.addEventListener('keyup',e=>{if(e.code==='Space'&&state.holding){e.preventDefault();stopTxNow();}});
 $('audio-unlock').onclick=()=>audio.ensurePlayback().then(()=>{setAudioReadyUI(true);toast('Áudio habilitado');sendWS({type:'sync_rx'});}).catch(handleError);

 document.addEventListener('visibilitychange',()=>{if(document.hidden){if(state.holding||state.txGranted)stopTxNow();status(state.wsReady?'Segundo plano — áudio pode ser suspenso':'Segundo plano');}else{if(state.wsReady)status('Conectado');if(state.screen==='verify')checkEmailVerification().catch(()=>{});else if(state.screen==='contribution')checkContribution().catch(()=>{});else if(state.screen==='account'){checkCurrentSession().then(()=>refreshAccountStatus()).catch(handleError);}else checkCurrentSession().catch(handleError);}});
 window.addEventListener('online',async()=>{await checkCurrentSession().catch(handleError);if(state.sessionId&&!state.sessionEnded&&!state.wsReady)startWS();});
 createVuMeter();
}
async function boot(){
 try{
   wire();
   window.ZLINK_APP_EVENTS_READY=true;
   screen('login');state.deviceId=deviceId();
   // Se o provedor não responder, evita uma tela de carregamento eterna.
   setTimeout(()=>{
     if($('startup-session')?.hidden===false){
       hideStartupOverlay();
       if(state.screen==='login')registrationMessage('login-message','Não foi possível verificar sua sessão. Confira sua conexão e tente entrar.');
     }
   },25000);
   if('serviceWorker' in navigator&&location.protocol==='https:')navigator.serviceWorker.register('./sw.js').catch(()=>{});
   const config=cfg.firebase||{};
   if(!config.apiKey || String(config.apiKey).includes('COLOQUE_')){
     console.warn('[ZLINK WEB] Autenticação não inicializada: configuração pública indisponível.');
     registrationMessage('login-message','O serviço de login está temporariamente indisponível. Contate o suporte.');
     hideStartupOverlay();
     return;
   }
   const fb=initializeApp(config);
   state.auth=getAuth(fb);
   await setPersistence(state.auth,browserLocalPersistence);
   onAuthStateChanged(state.auth,async user=>{
     state.user=user;
     if(!user){
       state.registrationStatus=null;state.registrationRecovery=null;state.paymentRef='';state.selectedAccessPlan='';state.signupInProgress=false;
       stopConnection();state.sessionId='';state.wsReady=false;state.profile=null;state.channels=[];state.selected=null;state.rxTransmission=null;state.usersChannelId=null;
       if(!state.sessionClosing)status('Desconectado');
       screen('login');hideStartupOverlay();return;
     }
     if(state.signupInProgress){hideStartupOverlay();return;}
     try{await routeAuthenticatedUser();}
     finally{hideStartupOverlay();}
   },error=>{
     console.error('[LOGIN] Observador de sessão:',error?.code||error?.message);
     registrationMessage('login-message',loginErrorMessage(error));
     hideStartupOverlay();
   });
 }catch(error){
   console.error('[LOGIN] Inicialização falhou:',error?.code||error?.message);
   registrationMessage('login-message',loginErrorMessage(error));
   hideStartupOverlay();
 }
}
if(window.ZLINK_STANDALONE) boot();
