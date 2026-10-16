// Configuracao publica do Firebase Web. Preencha apiKey antes de publicar.
// NUNCA coloque credenciais Admin, private keys, token mestre ou SMTP neste arquivo.
window.ZLINK_WEB_CONFIG = Object.freeze({
  firebase: {
    apiKey: 'COLOQUE_A_WEB_API_KEY_DO_FIREBASE',
    authDomain: 'z-link-talk.firebaseapp.com',
    projectId: 'z-link-talk',
    appId: ''
  },
  apiBase: 'https://servidor.zlinktalk.com.br',
  wsUrl: 'wss://servidor.zlinktalk.com.br',
  renewalUrl: 'https://zlinktalk.com.br/renovar',
  siteUrl: 'https://zlinktalk.com.br/'
});
