// =====================================================================
// AGENDA PET – Configurações
// Preencha com os dados do seu projeto no Supabase:
//   Project Settings > API > Project URL  e  anon public key
// =====================================================================
window.CONFIG = {
  SUPABASE_URL: 'https://COLE-AQUI.supabase.co',
  SUPABASE_ANON_KEY: 'COLE-AQUI-a-chave-publishable-ou-anon',
  WHATSAPP_LOJA: '1199999-9999',
  NOME_SISTEMA: 'Agenda Pet',

  // Aviso de "pet pronto" pelo WhatsApp
  //  false = abre o WhatsApp Web com a mensagem pronta (é só clicar em enviar)
  //  true  = envia sozinho pela Edge Function "notificar-whatsapp" (precisa de Z-API ou Meta)
  WHATSAPP_AUTOMATICO: false,
  DDI: '55',
  NOME_EMPRESA_MENSAGEM: 'Banho e Tosa',
  MENSAGEM_PRONTO:
    'Olá, {tutor}! O banho do(a) {pet} foi finalizado e ele(a) já está pronto(a) para ser retirado(a). Obrigado pela confiança! – {empresa}',

  // Sugestões de horários livres na tela de cadastro (só sugestão;
  // qualquer horário HH:MM pode ser digitado)
  HORARIO_INICIO: '07:00',
  HORARIO_FIM: '19:00',
  INTERVALO_MIN: 30
};
