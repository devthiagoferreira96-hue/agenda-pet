/* =====================================================================
   AGENDA PET – lógica do sistema
   ===================================================================== */
(function () {
  'use strict';

  const C = window.CONFIG || {};
  const MSG_CONFLITO = 'Infelizmente já temos um animal cadastrado neste horário.';
  const NOMES_PAPEL = { admin: 'Administrador', petshop: 'Pet Shop', banho_tosa: 'Banho e Tosa', teste: 'Teste' };
  const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho',
    'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------- estado ----------
  const estado = {
    sessao: null,
    perfil: null,
    diaAgenda: hojeISO(),
    filtro: 'ativos',
    visao: 'dia',              // 'dia' ou 'semana'
    itensSemana: [],
    buscaAtual: null,
    itensDia: [],
    ocupadosForm: [],          // horários ocupados na data do formulário
    agrupar: 'dia',
    canal: null,
    grafico: null,
    destacar: null,            // horário a destacar após conflito
    dataOriginal: null         // data do agendamento que está sendo editado
  };

  function erroConfig(msg) {
    document.body.innerHTML =
      '<div class="login"><div class="login-card"><h2>Configuração pendente</h2>' +
      `<p>${msg}</p><p>Abra o arquivo <b>config.js</b> e confira os dados do Supabase ` +
      '(Supabase › Project Settings › API).</p></div></div>';
  }
  const url = String(C.SUPABASE_URL || '').trim();
  const chave = String(C.SUPABASE_ANON_KEY || '').trim();
  if (!window.supabase) { erroConfig('Não foi possível carregar a biblioteca do Supabase. Confira se a pasta "vendor" com o arquivo supabase.js foi enviada junto com o site (veja o LEIAME) e se há internet.'); return; }
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url)) {
    erroConfig('SUPABASE_URL deve ser o endereço do projeto, no formato <b>https://xxxxxxxx.supabase.co</b> (não é uma chave).');
    return;
  }
  if (!chave || chave.startsWith('sb_secret_') || chave.includes('COLE-AQUI')) {
    erroConfig('SUPABASE_ANON_KEY deve ser a chave <b>publishable</b> (sb_publishable_…) ou <b>anon public</b>. ' +
      'Nunca use a chave secreta (sb_secret_… / service_role) no navegador.');
    return;
  }

  const sb = window.supabase.createClient(url, chave);
  $$('.nome-sistema').forEach((el) => { el.textContent = C.NOME_SISTEMA || 'Agenda Pet'; });
  document.title = C.NOME_SISTEMA || 'Agenda Pet';

  /* =================================================================
     Utilidades de data, hora e texto
     ================================================================= */
  function pad(n) { return String(n).padStart(2, '0'); }
  // "Hoje" sempre pelo horário de Brasília (America/Sao_Paulo), igual ao banco de dados
  const FMT_BRASIL = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
  function hojeISO() {
    try { return FMT_BRASIL.format(new Date()); }
    catch (e) { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  }
  function isoParaBR(iso) { if (!iso) return ''; const [a, m, d] = iso.split('-'); return `${d}/${m}/${a}`; }
  function brParaISO(br) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(br || '');
    if (!m) return null;
    const d = +m[1], mes = +m[2], a = +m[3];
    const dt = new Date(a, mes - 1, d);
    if (dt.getFullYear() !== a || dt.getMonth() !== mes - 1 || dt.getDate() !== d) return null;
    return `${a}-${pad(mes)}-${pad(d)}`;
  }
  // data anterior a hoje (ao editar, manter a data original de um agendamento antigo é permitido)
  const DATA_MAXIMA = '2100-12-31';
  function dataAlemDoLimite(iso) { return iso > DATA_MAXIMA; }
  function dataPassada(iso) { return iso < hojeISO() && iso !== estado.dataOriginal; }
  function horaValida(h) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(h || ''); }
  function hhmm(t) { return (t || '').slice(0, 5); }
  function somarDias(iso, n) { const [a, m, d] = iso.split('-').map(Number); const dt = new Date(a, m - 1, d + n); return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`; }
  function diaPorExtenso(iso) {
    const [a, m, d] = iso.split('-').map(Number);
    const t = new Date(a, m - 1, d).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  // Endereço no formato que o Google Maps e o Waze reconhecem:
  // "Rua X, 123 - Bairro, Cidade - UF, 00000-000, Brasil"
  function enderecoParaMapa(rua, numero, bairro, cidade, cep) {
    const cid = String(cidade || '').replace(/\s*\/\s*([A-Za-z]{2})$/, ' - $1').trim();   // São Paulo/SP -> São Paulo - SP
    const c = String(cep || '').replace(/\D/g, '');
    const inicio = [rua && `${rua}, ${numero || 's/n'}`, bairro].filter(Boolean).join(' - ');
    return [inicio, cid, c.length === 8 ? `${c.slice(0, 5)}-${c.slice(5)}` : '', 'Brasil'].filter(Boolean).join(', ');
  }
  function soDigitos(s) { return String(s || '').replace(/\D/g, ''); }
  function formatarTelefone(dig) {
    dig = soDigitos(dig).slice(0, 11);
    if (dig.length <= 2) return dig ? `(${dig}` : '';
    if (dig.length <= 6) return `(${dig.slice(0, 2)}) ${dig.slice(2)}`;
    if (dig.length <= 10) return `(${dig.slice(0, 2)}) ${dig.slice(2, 6)}-${dig.slice(6)}`;
    return `(${dig.slice(0, 2)}) ${dig.slice(2, 7)}-${dig.slice(7)}`;
  }

  // máscaras de digitação
  function mascaraData(el) {
    el.addEventListener('input', () => {
      const d = soDigitos(el.value).slice(0, 8);
      el.value = d.length > 4 ? `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}` : d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
    });
  }
  function mascaraHora(el) {
    el.addEventListener('input', () => {
      const d = soDigitos(el.value).slice(0, 4);
      el.value = d.length > 2 ? `${d.slice(0, 2)}:${d.slice(2)}` : d;
    });
  }

  /* =================================================================
     Avisos (toast e janela)
     ================================================================= */
  function toast(texto, tipo = '') {
    const t = document.createElement('div');
    t.className = `toast ${tipo}`;
    t.textContent = texto;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), Math.max(4500, String(texto).length * 70));   // mensagem longa fica mais tempo
  }

  function janela({ titulo, texto, erro = false, extra = null, botoes = [{ rotulo: 'OK', classe: 'btn-primario' }] }) {
    return new Promise((resolve) => {
      const m = $('#modal');
      m.classList.toggle('erro', erro);
      $('#modal-titulo').textContent = titulo;
      $('#modal-texto').textContent = texto || '';
      const caixaExtra = $('#modal-extra');
      caixaExtra.innerHTML = '';
      if (extra) caixaExtra.appendChild(extra);
      const acoes = $('#modal-acoes');
      acoes.innerHTML = '';
      botoes.forEach((b, i) => {
        const el = document.createElement('button');
        el.className = `btn ${b.classe || 'btn-fantasma'}`;
        el.textContent = b.rotulo;
        el.addEventListener('click', () => {
          if (b.validar && !b.validar()) return;            // ex.: motivo do cancelamento não escolhido
          m.hidden = true; resolve(b.valor ?? i);
        });
        acoes.appendChild(el);
      });
      m.hidden = false;
      acoes.lastChild.focus();
    });
  }
  const confirmar = (titulo, texto, rotulo = 'Confirmar', classe = 'btn-primario') =>
    janela({ titulo, texto, botoes: [{ rotulo: 'Voltar', valor: false }, { rotulo, classe, valor: true }] });

  /* =================================================================
     Login e sessão
     ================================================================= */
  async function iniciar() {
    // veio do link "redefinir senha" do e-mail?
    let recuperacao = /type=recovery/.test(location.hash);
    sb.auth.onAuthStateChange((evento, sessao) => {
      if (evento === 'SIGNED_OUT') mostrarLogin();
      if (evento === 'TOKEN_REFRESHED' && sessao) estado.sessao = sessao;
      if (evento === 'PASSWORD_RECOVERY') {
        recuperacao = true;
        if (sessao && !estado.sessao) entrar(sessao).then(pedirNovaSenha); else pedirNovaSenha();
      }
    });
    const { data } = await sb.auth.getSession();
    if (data.session) { await entrar(data.session); if (recuperacao) pedirNovaSenha(); }
    else mostrarLogin();
  }

  /* -----------------------------------------------------------------
     Esqueci minha senha: envia o link por e-mail e, ao voltar pelo link,
     pede a nova senha
     ----------------------------------------------------------------- */
  $('#btn-esqueci').addEventListener('click', async () => {
    const digitado = $('#login-email').value.trim();
    if (!digitado.includes('@')) {
      // celular digitado = tutor; campo vazio = pergunta quem é
      const quem = soDigitos(digitado).length >= 10 ? 'tutor'
        : await janela({ titulo: 'Esqueci minha senha', texto: 'Você é tutor (entra com o celular) ou da equipe da loja (entra com o e-mail)?',
          botoes: [{ rotulo: 'Sou da equipe', valor: 'equipe' }, { rotulo: 'Sou tutor', classe: 'btn-primario', valor: 'tutor' }] });
      if (quem === 'tutor') return esqueciSenhaTutor(digitado);
      if (quem !== 'equipe') return;
    }
    const caixa = document.createElement('div');
    caixa.className = 'motivo-cancel';
    caixa.innerHTML = `<label>E-mail do usuário<input id="r-email" type="email" autocomplete="username" maxlength="120"></label>
      <p class="erro-texto" id="r-erro" role="alert"></p>`;
    caixa.querySelector('#r-email').value = $('#login-email').value.trim();
    let email = '';
    const ok = await janela({
      titulo: 'Esqueci minha senha',
      texto: 'Digite o e-mail do seu usuário. Vamos enviar um link para você criar uma nova senha.',
      extra: caixa,
      botoes: [{ rotulo: 'Voltar', valor: false }, { rotulo: 'Enviar link', classe: 'btn-primario', valor: true, validar: () => {
        email = caixa.querySelector('#r-email').value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { caixa.querySelector('#r-erro').textContent = 'Digite um e-mail válido.'; return false; }
        return true;
      } }]
    });
    if (!ok) return;
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    // mensagem igual exista ou não o e-mail (não revela quem tem cadastro)
    if (error && /rate|seconds|limit/i.test(error.message || '')) {
      return janela({ titulo: 'Aguarde um pouco', texto: 'Muitos pedidos seguidos. Espere alguns minutos e tente de novo.' });
    }
    janela({ titulo: 'Verifique seu e-mail', texto: `Se ${email} for um usuário do sistema, você vai receber em instantes um e-mail com o link para criar uma nova senha.\n\nNão chegou? Olhe a caixa de spam.` });
  });

  let pedindoSenha = false;
  async function pedirNovaSenha() {
    if (pedindoSenha) return;
    pedindoSenha = true;
    try {
      for (;;) {
        const caixa = document.createElement('div');
        caixa.className = 'motivo-cancel';
        caixa.innerHTML = `<label>Nova senha<input id="n-senha" type="password" autocomplete="new-password" minlength="8" maxlength="72"></label>
          <label>Repita a nova senha<input id="n-senha2" type="password" autocomplete="new-password" maxlength="72"></label>
          <p class="dica-transporte">Mínimo de 8 caracteres. Dica: misture letras e números.</p>
          <p class="erro-texto" id="n-erro" role="alert"></p>`;
        let senha = '';
        const ok = await janela({
          titulo: 'Criar nova senha',
          texto: 'Escolha a nova senha do seu usuário.',
          extra: caixa,
          botoes: [{ rotulo: 'Depois', valor: false }, { rotulo: 'Salvar nova senha', classe: 'btn-primario', valor: true, validar: () => {
            const a = caixa.querySelector('#n-senha').value, b = caixa.querySelector('#n-senha2').value;
            const erro = a.length < 8 ? 'A senha precisa ter pelo menos 8 caracteres.' : a !== b ? 'As duas senhas não são iguais.' : '';
            caixa.querySelector('#n-erro').textContent = erro;
            if (erro) return false;
            senha = a; return true;
          } }]
        });
        if (!ok) break;
        const { error } = await sb.auth.updateUser({ password: senha });
        if (!error) { toast('Senha alterada com sucesso.', 'ok'); break; }
        await janela({ titulo: 'Não foi possível trocar a senha', erro: true,
          texto: /different|same/i.test(error.message || '') ? 'A nova senha precisa ser diferente da anterior.'
            : /weak|short|characters/i.test(error.message || '') ? 'Senha muito fraca. Use pelo menos 8 caracteres, com letras e números.'
            : 'O link pode ter expirado. Peça um novo link em "Esqueci minha senha".' });
      }
    } finally {
      pedindoSenha = false;
      if (/type=recovery|access_token|code=/.test(location.hash + location.search)) history.replaceState(null, '', location.pathname);
    }
  }

  function mostrarLogin() {
    if (estado.canal) { sb.removeChannel(estado.canal); estado.canal = null; }
    estado.sessao = null; estado.perfil = null; estado.tutor = null;
    $('#tela-app').hidden = true;
    $('#tela-tutor').hidden = true;
    if (querCadastro()) return mostrarCriarConta();
    $('#tela-conta').hidden = true;
    $('#tela-login').hidden = false;
    $('#login-email').focus();
  }

  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-erro').textContent = '';
    const btn = e.submitter; btn.disabled = true;
    const usuario = $('#login-email').value.trim();
    const email = emailDoLogin(usuario);
    if (!email) {
      btn.disabled = false;
      $('#login-erro').textContent = 'Digite o seu e-mail (equipe) ou o celular com DDD (tutor).';
      return;
    }
    const { data, error } = await sb.auth.signInWithPassword({ email, password: $('#login-senha').value });
    btn.disabled = false;
    if (error) { $('#login-erro').textContent = usuario.includes('@') ? 'E-mail ou senha incorretos.' : 'Celular ou senha incorretos.'; return; }
    await entrar(data.session);
  });

  async function entrar(sessao) {
    estado.sessao = sessao;
    const { data: perfil, error } = await sb.from('perfis').select('id, nome, papel').eq('id', sessao.user.id).maybeSingle();
    if (!error && !perfil) {
      // não é da equipe: pode ser um tutor (área "Meus pets", sem agenda)
      const { data: tutor } = await sb.from('tutores').select('*').eq('user_id', sessao.user.id).maybeSingle();
      if (tutor) return entrarTutor(tutor);
    }
    if (error || !perfil) {
      await sb.auth.signOut();
      $('#login-erro').textContent = 'Usuário sem permissão. Peça ao administrador para liberar seu acesso.';
      mostrarLogin();
      return;
    }
    estado.perfil = perfil;
    const selo = $('#usuario-nome');
    selo.textContent = perfil.nome || NOMES_PAPEL[perfil.papel];
    selo.className = `selo selo-${perfil.papel}`;
    // aba Histórico só para o administrador (o banco também só entrega o histórico ao admin)
    const ehAdmin = perfil.papel === 'admin';
    $('#aba-btn-historico').hidden = !ehAdmin;
    if (!ehAdmin && !$('#aba-historico').hidden) $('[data-aba="agenda"]').click();
    if (ehAdmin) setTimeout(lembrarBackup, 1500);
    $('#tela-login').hidden = true;
    $('#tela-app').hidden = false;
    limparForm();
    irParaDia(hojeISO());
    assinarTempoReal();
  }

  $('#btn-sair').addEventListener('click', () => sb.auth.signOut());

  /* =================================================================
     Tempo real: quando o outro computador mexe, a tela atualiza sozinha
     ================================================================= */
  function assinarTempoReal() {
    if (estado.canal) sb.removeChannel(estado.canal);
    estado.canal = sb.channel('agendamentos-tempo-real')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agendamentos' }, (payload) => {
        const reg = payload.new && payload.new.id ? payload.new : payload.old || {};
        const deOutro = reg.criado_por && reg.criado_por !== estado.sessao?.user.id;
        if (payload.eventType === 'INSERT' && deOutro) {
          toast(`${NOMES_PAPEL[reg.origem] || 'Outro usuário'} agendou ${reg.pet_nome || 'um animal'} em ${isoParaBR(reg.data)} às ${hhmm(reg.horario)}.`);
        }
        carregarDia();
        atualizarOcupadosForm();
        if (!$('#aba-graficos').hidden) carregarGraficos();
      })
      .subscribe((status) => { $('#status-conexao').classList.toggle('on', status === 'SUBSCRIBED'); });
  }

  /* =================================================================
     Abas
     ================================================================= */
  $$('.aba').forEach((b) => b.addEventListener('click', () => {
    $$('.aba').forEach((x) => { x.classList.toggle('ativa', x === b); x.setAttribute('aria-selected', x === b); });
    $('#aba-agenda').hidden = b.dataset.aba !== 'agenda';
    $('#aba-graficos').hidden = b.dataset.aba !== 'graficos';
    $('#aba-historico').hidden = b.dataset.aba !== 'historico';
    $('#aba-passeio').hidden = b.dataset.aba !== 'passeio';
    if (b.dataset.aba === 'passeio') abrirPasseio();
    if (b.dataset.aba === 'graficos') carregarGraficos();
    if (b.dataset.aba === 'historico') { mostrarStatusBackup(); carregarHistorico(true); }
  }));

  /* =================================================================
     Agenda do dia
     ================================================================= */
  const campoDia = $('#agenda-data');
  mascaraData(campoDia);
  campoDia.addEventListener('change', () => {
    const iso = brParaISO(campoDia.value);
    if (iso) irParaDia(iso); else campoDia.value = isoParaBR(estado.diaAgenda);
  });
  campoDia.addEventListener('keydown', (e) => { if (e.key === 'Enter') campoDia.dispatchEvent(new Event('change')); });
  const passo = () => (estado.visao === 'semana' ? 7 : 1);
  $('#dia-anterior').addEventListener('click', () => irParaDia(somarDias(estado.diaAgenda, -passo())));
  $('#dia-seguinte').addEventListener('click', () => irParaDia(somarDias(estado.diaAgenda, passo())));
  $('#dia-hoje').addEventListener('click', () => irParaDia(hojeISO()));
  $$('[data-filtro]').forEach((b) => b.addEventListener('click', () => {
    estado.filtro = b.dataset.filtro;
    $$('[data-filtro]').forEach((x) => x.classList.toggle('ativo', x === b));
    if (estado.visao === 'semana') desenharSemana(); else desenharDia();
  }));

  function irParaDia(iso) {
    estado.diaAgenda = iso;
    campoDia.value = isoParaBR(iso);
    $('#agenda-titulo').textContent = estado.visao === 'semana' ? tituloSemana(iso) : diaPorExtenso(iso);
    $('#ps-titulo').textContent = diaPorExtenso(iso);
    $('#ps-data').textContent = isoParaBR(iso);
    carregarDia();
  }

  // Recarrega o que estiver na tela (dia ou semana; e a busca, se estiver aberta)
  function carregarDia() {
    if (estado.buscaAtual) buscarAgenda(estado.buscaAtual);
    return estado.visao === 'semana' ? carregarSemana() : carregarDiaLista();
  }

  // ---------------------------------------------------------------
  // Visão da semana (domingo a sábado)
  // ---------------------------------------------------------------
  const DIAS_SEM = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const MESES_MIN = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  function inicioSemana(iso) {
    const [a, m, d] = iso.split('-').map(Number);
    return somarDias(iso, -new Date(a, m - 1, d).getDay());
  }
  function tituloSemana(iso) {
    const ini = inicioSemana(iso), fim = somarDias(ini, 6);
    const [a1, m1, d1] = ini.split('-').map(Number), [a2, m2, d2] = fim.split('-').map(Number);
    if (a1 !== a2) return `Semana de ${d1} de ${MESES_MIN[m1 - 1]} de ${a1} a ${d2} de ${MESES_MIN[m2 - 1]} de ${a2}`;
    if (m1 !== m2) return `Semana de ${d1} de ${MESES_MIN[m1 - 1]} a ${d2} de ${MESES_MIN[m2 - 1]} de ${a2}`;
    return `Semana de ${d1} a ${d2} de ${MESES_MIN[m2 - 1]} de ${a2}`;
  }
  $$('[data-visao]').forEach((b) => b.addEventListener('click', () => {
    if (estado.visao === b.dataset.visao) return;
    estado.visao = b.dataset.visao;
    $$('[data-visao]').forEach((x) => { const on = x === b; x.classList.toggle('ativo', on); x.setAttribute('aria-pressed', on); });
    $('#lista-agenda').hidden = estado.visao === 'semana';
    $('#semana-grade').hidden = estado.visao !== 'semana';
    irParaDia(estado.diaAgenda);
  }));
  async function carregarSemana() {
    const ini = inicioSemana(estado.diaAgenda), fim = somarDias(ini, 6), pedido = estado.diaAgenda;
    const { data, error } = await sb.from('agendamentos').select('*')
      .gte('data', ini).lte('data', fim).order('data', { ascending: true }).order('horario', { ascending: true });
    if (pedido !== estado.diaAgenda || estado.visao !== 'semana') return;
    if (error) { toast('Não foi possível carregar a semana.', 'erro'); return; }
    estado.itensSemana = data || [];
    desenharSemana();
  }
  function desenharSemana() {
    const filtro = estado.filtro;
    const todos = estado.itensSemana || [];
    const ini = inicioSemana(estado.diaAgenda), hoje = hojeISO();
    const ativos = todos.filter((a) => a.status !== 'cancelado');
    $('#agenda-resumo').innerHTML =
      `<span><b>${ativos.length}</b> na semana</span>` +
      `<span><b>${todos.filter((a) => a.status === 'finalizado').length}</b> finalizado(s)</span>` +
      `<span><b>${todos.filter((a) => a.status === 'entregue').length}</b> entregue(s)</span>`;
    let html = '';
    for (let i = 0; i < 7; i++) {
      const dia = somarDias(ini, i);
      const [, m, d] = dia.split('-').map(Number);
      const itens = todos.filter((a) => a.data === dia && (filtro === 'ativos' ? a.status !== 'cancelado' : a.status === filtro));
      html += `<section class="sem-dia${dia === hoje ? ' sem-hoje' : ''}${i === 0 ? ' sem-dom' : ''}">
        <button class="sem-cab" data-ir-dia="${dia}" title="Abrir este dia"><span>${DIAS_SEM[i]}</span><b>${pad(d)}/${pad(m)}</b>${itens.length ? `<em>${itens.length}</em>` : ''}</button>
        <div class="sem-itens">${itens.length ? itens.map((a) => `
          <button class="sem-item st-${esc(a.status)}" data-ir-dia="${dia}" data-ir-hora="${hhmm(a.horario)}">
            <span class="sem-hora">${hhmm(a.horario)}</span>
            <span class="sem-pet">${esc(a.pet_nome)}${a.saude_obs ? ' <span class="sem-alerta" title="Alerta de saúde">!</span>' : ''}</span>
            <span class="sem-tutor">${esc(a.tutor_nome)}${a.servico ? ` · ${esc(a.servico)}` : ''}</span>
          </button>`).join('') : '<p class="sem-vazio">—</p>'}</div>
      </section>`;
    }
    $('#semana-grade').innerHTML = html;
  }
  // clicar num dia ou animal da semana abre o dia (e destaca o horário)
  $('#semana-grade').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ir-dia]');
    if (!b) return;
    estado.destacar = b.dataset.irHora || null;
    $('[data-visao="dia"]').click();
    irParaDia(b.dataset.irDia);
  });

  // ---------------------------------------------------------------
  // Busca por pet, tutor ou telefone em todas as datas
  // ---------------------------------------------------------------
  const campoBusca = $('#busca-agenda');
  let buscaTimer = null, buscaSeq = 0;
  campoBusca.addEventListener('input', () => {
    clearTimeout(buscaTimer);
    const q = campoBusca.value.trim();
    $('#busca-limpar').hidden = !q;
    if (q.length < 2) { fecharBusca(false); return; }
    buscaTimer = setTimeout(() => buscarAgenda(q), 300);
  });
  campoBusca.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharBusca(true); });
  $('#busca-limpar').addEventListener('click', () => fecharBusca(true));
  function fecharBusca(limparCampo) {
    estado.buscaAtual = null;
    if (limparCampo) { campoBusca.value = ''; $('#busca-limpar').hidden = true; }
    $('#resultado-busca').hidden = true;
    $('#resultado-busca').innerHTML = '';
    $$('.painel-agenda, .painel-passeio').forEach((el) => el.classList.remove('buscando'));
  }
  // No celular, com a aba Passeio aberta, a busca procura só os pets do Leva e traz
  const buscaNoPasseio = () => !$('#aba-passeio').hidden && window.matchMedia('(max-width: 640px)').matches;
  function htmlBuscaPasseio(lista, q, hoje) {
    const grupo = (tipo, titulo, itens, endDe, situacao) => `
      <section class="bp-grupo bp-${tipo}">
        <h4>${titulo} <small>(${itens.length})</small></h4>
        ${itens.length ? `<ul class="busca-lista">${itens.map((a) => {
          const [sit, cls] = situacao(a);
          return `<li><button class="busca-item st-${esc(a.status)}${a.data < hoje ? ' passado' : ''}" data-ir-dia="${esc(a.data)}" data-lv-focar="${tipo}:${esc(a.id)}">
            <span class="busca-data">${isoParaBR(a.data)}<small>${hhmm(a.horario)}</small></span>
            <span class="busca-info"><span class="busca-linha"><b>${esc(a.pet_nome)}</b> · tutor ${esc(a.tutor_nome)}</span>
              <span class="bp-end">${ICONE_PINO}<span>${esc(textoEnd(endDe(a)) || 'Endereço não informado')}</span></span>
              <span class="busca-tags"><span class="tag ${cls}">${sit}</span></span></span>
          </button></li>`;
        }).join('')}</ul>` : '<p class="nota">Nenhum pet encontrado neste grupo.</p>'}
      </section>`;
    const buscar = lista.filter((a) => a.busca_domicilio);
    const levar = lista.filter((a) => a.entrega_domicilio);
    return `<div class="busca-cab"><span><b>${lista.length}${lista.length === 40 ? '+' : ''}</b> pet(s) no Leva e traz para "${esc(q)}"</span>
        <button class="btn btn-fantasma btn-pequeno" id="busca-fechar">Voltar</button></div>`
      + grupo('busca', '🏠➜🐾 Buscar', buscar, endBusca, situacaoBusca)
      + grupo('entrega', '🐾➜🏠 Levar', levar, endEntrega, situacaoEntrega);
  }

  async function buscarAgenda(q) {
    // só letras, números, espaço, hífen e apóstrofo (evita quebrar a consulta)
    const texto = q.normalize('NFC').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
    const digitos = soDigitos(q);
    if (texto.length < 2 && digitos.length < 3) return;
    estado.buscaAtual = q;
    const seq = ++buscaSeq;
    const filtros = [];
    if (texto.length >= 2) filtros.push(`pet_nome.ilike.*${texto}*`, `tutor_nome.ilike.*${texto}*`);
    if (digitos.length >= 3) filtros.push(`telefone.ilike.*${digitos}*`);
    const passeio = buscaNoPasseio();
    let consulta = sb.from('agendamentos')
      .select(passeio ? '*' : 'id, data, horario, pet_nome, tutor_nome, telefone, status, origem, servico')
      .or(filtros.join(','));
    if (passeio) consulta = consulta.or('busca_domicilio.eq.true,entrega_domicilio.eq.true').neq('status', 'cancelado');
    const { data, error } = await consulta.order('data', { ascending: false }).limit(40);
    if (seq !== buscaSeq || estado.buscaAtual !== q) return;
    const caixa = $('#resultado-busca');
    (caixa.closest('.painel') || $('.painel-agenda')).classList.add('buscando');
    caixa.hidden = false;
    if (error) { caixa.innerHTML = '<p class="vazio">Não foi possível buscar agora.</p>'; return; }
    const hoje = hojeISO();
    const lista = (data || []).slice().sort((a, b) => {           // próximos primeiro, depois os passados (mais recentes antes)
      const fa = a.data >= hoje, fb = b.data >= hoje;
      if (fa !== fb) return fa ? -1 : 1;
      const k = (a.data + a.horario).localeCompare(b.data + b.horario);
      return fa ? k : -k;
    });
    if (passeio) { caixa.innerHTML = htmlBuscaPasseio(lista, q, hoje); return; }
    caixa.innerHTML = `<div class="busca-cab"><span><b>${lista.length}${lista.length === 40 ? '+' : ''}</b> resultado(s) para "${esc(q)}"</span>
        <button class="btn btn-fantasma btn-pequeno" id="busca-fechar">Voltar à agenda</button></div>`
      + (lista.length ? `<ul class="busca-lista">${lista.map((a) => `
        <li><button class="busca-item st-${esc(a.status)}${a.data < hoje ? ' passado' : ''}" data-ir-dia="${esc(a.data)}" data-ir-hora="${hhmm(a.horario)}">
          <span class="busca-data">${isoParaBR(a.data)}<small>${hhmm(a.horario)}</small></span>
          <span class="busca-info"><span class="busca-linha"><b>${esc(a.pet_nome)}</b> · tutor ${esc(a.tutor_nome)}${a.telefone ? ` · <span class="sem-quebra">${esc(formatarTelefone(a.telefone))}</span>` : ''}</span>
            <span class="busca-tags"><span class="tag tag-${esc(a.status)}">${NOMES_STATUS[a.status] || esc(a.status)}</span><span class="tag tag-${esc(a.origem)}">${esc(NOMES_PAPEL[a.origem] || a.origem)}</span>${a.servico ? `<span class="tag tag-servico">${esc(a.servico)}</span>` : ''}</span></span>
        </button></li>`).join('')}</ul>` : '<p class="vazio">Nenhum agendamento encontrado.</p>');
  }
  $('#resultado-busca').addEventListener('click', (e) => {
    if (e.target.closest('#busca-fechar')) return fecharBusca(true);
    const b = e.target.closest('[data-ir-dia]');
    if (!b) return;
    fecharBusca(true);
    if (b.dataset.lvFocar) {                                            // resultado do Leva e traz: continua no Passeio
      estado.focarLeva = b.dataset.lvFocar;
      return irParaDia(b.dataset.irDia);
    }
    estado.destacar = b.dataset.irHora;
    if (!$('#aba-passeio').hidden) $('[data-aba="agenda"]').click();
    if (estado.visao === 'semana') $('[data-visao="dia"]').click();
    irParaDia(b.dataset.irDia);
  });

  async function carregarDiaLista() {
    const dia = estado.diaAgenda;
    const { data, error } = await sb.from('agendamentos').select('*')
      .eq('data', dia).order('horario', { ascending: true }).order('criado_em', { ascending: true });
    if (dia !== estado.diaAgenda) return;            // usuário já trocou de dia
    if (error) { toast('Não foi possível carregar a agenda.', 'erro'); return; }
    estado.itensDia = data || [];
    desenharDia();
  }

  const ICONE_PINO = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="10" r="2.6" fill="currentColor"/></svg>';
  const NOMES_STATUS = { agendado: 'Agendado', em_banho: 'Em banho', finalizado: 'Finalizado', entregue: 'Entregue', cancelado: 'Cancelado' };
  const ICONE_ALERTA = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3 2 21h20L12 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v5M12 18h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  function desenharDia() {
    const todos = estado.itensDia;
    const f = estado.filtro;
    const itens = todos.filter((a) => (f === 'ativos' ? a.status !== 'cancelado' : a.status === f));
    const ativos = todos.filter((a) => a.status !== 'cancelado');
    $('#agenda-resumo').innerHTML =
      `<span><b>${ativos.length}</b> agendado(s)</span>` +
      `<span><b>${todos.filter((a) => a.status === 'em_banho').length}</b> em banho</span>` +
      `<span><b>${todos.filter((a) => a.status === 'finalizado').length}</b> finalizado(s)</span>` +
      `<span><b>${todos.filter((a) => a.status === 'entregue').length}</b> entregue(s)</span>` +
      `<span><b>${ativos.filter((a) => a.saude_obs).length}</b> com alerta de saúde</span>`;
    atualizarBotaoLeva();

    const lista = $('#lista-agenda');
    if (!itens.length) {
      lista.innerHTML = '<li class="vazio">Nenhum animal nesta data com este filtro.</li>';
      return;
    }
    const admin = estado.perfil?.papel === 'admin';
    lista.innerHTML = itens.map((a) => {
      const tags = [
        `<span class="tag tag-${a.origem}">${esc(NOMES_PAPEL[a.origem])}</span>`,
        `<span class="tag tag-${a.status}">${NOMES_STATUS[a.status] || a.status}</span>`,
        a.especie && `<span class="tag">${esc(a.especie)}</span>`,
        a.pet_sexo && `<span class="tag">${esc(a.pet_sexo)}</span>`,
        a.pet_idade && `<span class="tag">${esc(a.pet_idade)}</span>`,
        a.porte && `<span class="tag">Porte ${esc(a.porte.toLowerCase())}</span>`,
        a.peso_kg && `<span class="tag">${String(a.peso_kg).replace('.', ',')} kg</span>`,
        a.raca && `<span class="tag">${esc(a.raca)}</span>`,
        a.pelagem && `<span class="tag">Pelo ${esc(a.pelagem.toLowerCase())}</span>`,
        a.servico && `<span class="tag tag-servico">${esc(a.servico)}${a.servico_valor != null ? ` · ${dinheiro(a.servico_valor)}` : ''}</span>`,
        (a.busca_domicilio || a.entrega_domicilio) && `<span class="tag tag-transporte">${
          a.busca_domicilio && a.entrega_domicilio ? (a.entrega_outro_end ? 'Busca e entrega em endereços diferentes' : 'Busca e entrega em casa')
          : a.busca_domicilio ? 'Buscar em casa' : 'Entregar em casa'}</span>`
      ].filter(Boolean).join('');
      // endereço(s) do leva e traz, cada um com link para o mapa
      const linhaEndereco = (rotulo, rua, numero, bairro, cidade, cep, referencia) => {
        if (!rua) return '';
        const cepFmt = cep ? String(cep).replace(/^(\d{5})(\d{3})$/, '$1-$2') : '';
        const partes = [`${rua}, ${numero || 's/n'}`, bairro, cidade, cepFmt && `CEP ${cepFmt}`].filter(Boolean);
        const mapa = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(enderecoParaMapa(rua, numero, bairro, cidade, cep));
        // cada parte do endereço não quebra no meio (ex.: CEP 01310-100 fica inteiro)
        const textoEnd = partes.map((p) => `<span class="sem-quebra-parte">${esc(p)}</span>`).join(' – ');
        return `<div class="item-endereco">${ICONE_PINO}<span>${rotulo ? `<b>${rotulo}:</b> ` : ''}${textoEnd} · <a href="${mapa}" target="_blank" rel="noopener">Abrir no mapa</a>`
          + `${referencia ? `<br>Referência: ${esc(referencia)}` : ''}</span></div>`;
      };
      let endereco = '';
      if (a.busca_domicilio || a.entrega_domicilio) {
        if (a.entrega_outro_end) {
          endereco = linhaEndereco('Busca', a.end_rua, a.end_numero, a.end_bairro, a.end_cidade, a.end_cep, a.end_referencia)
            + linhaEndereco('Entrega', a.ent_rua, a.ent_numero, a.ent_bairro, a.ent_cidade, a.ent_cep, a.ent_referencia);
        } else {
          endereco = linhaEndereco('', a.end_rua, a.end_numero, a.end_bairro, a.end_cidade, a.end_cep, a.end_referencia);
        }
      }
      const tel = a.telefone ? ` · <span class="sem-quebra">${esc(formatarTelefone(a.telefone))}</span>` : '';
      const acoes = [];
      if (a.status === 'agendado') {
        acoes.push(`<button class="btn btn-banho btn-pequeno" data-acao="iniciar" data-id="${esc(a.id)}">Iniciar banho</button>`);
        acoes.push(`<button class="btn btn-fantasma btn-pequeno" data-acao="finalizar" data-id="${esc(a.id)}">Finalizar</button>`);
        acoes.push(`<button class="btn btn-fantasma btn-pequeno" data-acao="editar" data-id="${esc(a.id)}">Editar</button>`);
        acoes.push(`<button class="btn btn-fantasma btn-pequeno" data-acao="cancelar" data-id="${esc(a.id)}">Cancelar</button>`);
      } else if (a.status === 'em_banho') {
        acoes.push(`<button class="btn btn-ok btn-pequeno" data-acao="finalizar" data-id="${esc(a.id)}">Finalizar</button>`);
        acoes.push(`<button class="btn btn-fantasma btn-pequeno" data-acao="reabrir" data-id="${esc(a.id)}">Voltar p/ agendado</button>`);
      } else if (a.status === 'finalizado') {
        acoes.push(`<button class="btn btn-entregar btn-pequeno" data-acao="entregar" data-id="${esc(a.id)}">Entregue ao tutor</button>`);
        if (a.telefone) acoes.push(`<button class="btn btn-fantasma btn-pequeno" data-acao="avisar" data-id="${esc(a.id)}">Avisar tutor</button>`);
        acoes.push(`<button class="btn btn-fantasma btn-pequeno" data-acao="reabrir" data-id="${esc(a.id)}">Reabrir</button>`);
      } else if (a.status === 'entregue') {
        acoes.push(`<button class="btn btn-fantasma btn-pequeno" data-acao="desfazer-entrega" data-id="${esc(a.id)}">Desfazer entrega</button>`);
      } else {
        acoes.push(`<button class="btn btn-fantasma btn-pequeno" data-acao="reabrir" data-id="${esc(a.id)}">Reativar</button>`);
      }
      if (admin) acoes.push(`<button class="btn btn-fantasma btn-pequeno" data-acao="excluir" data-id="${esc(a.id)}">Excluir</button>`);
      const destaque = estado.destacar && hhmm(a.horario) === estado.destacar && a.status !== 'cancelado' ? ' destaque' : '';
      const hora = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      let info = '';
      if (a.status === 'em_banho') {
        info = `<div class="item-obs item-em-banho">🛁 Banho iniciado${a.iniciado_em ? ` às ${hora(a.iniciado_em)}` : ''}</div>`;
      } else if (a.status === 'finalizado' && a.finalizado_em) {
        info = `<div class="item-obs">Finalizado às ${hora(a.finalizado_em)}${a.aviso_enviado_em ? ` · tutor avisado às ${hora(a.aviso_enviado_em)}` : ''} · aguardando retirada</div>`;
      } else if (a.status === 'cancelado' && a.motivo_cancelamento) {
        info = `<div class="item-obs item-cancelado"><b>Cancelado:</b> ${esc(a.motivo_cancelamento)}</div>`;
      } else if (a.status === 'entregue') {
        info = `<div class="item-obs item-entregue">${a.finalizado_em ? `Banho finalizado às ${hora(a.finalizado_em)} · ` : ''}<b>Entregue ao tutor${a.entregue_em ? ` às ${hora(a.entregue_em)}` : ''}</b></div>`;
      }
      return `<li class="item ${a.status}${destaque}" data-hora="${hhmm(a.horario)}">
        <div class="item-hora">${hhmm(a.horario)}</div>
        <div class="item-info">
          <div class="item-nome">${esc(a.pet_nome)} <small>· tutor ${esc(a.tutor_nome)}${tel}</small></div>
          <div class="item-tags">${tags}</div>
          ${a.saude_obs ? `<div class="item-saude">${ICONE_ALERTA}<span>${esc(a.saude_obs)}</span></div>` : ''}
          ${endereco}
          ${a.observacoes ? `<div class="item-obs">Obs.: ${esc(a.observacoes)}</div>` : ''}
          ${info}
        </div>
        <div class="item-acoes">${acoes[0] || ''}${acoes.length > 1
          ? `<button class="btn btn-fantasma btn-pequeno btn-mais" data-mais aria-expanded="false">Mais ▾</button><div class="acoes-extra">${acoes.slice(1).join('')}</div>`
          : ''}</div>
      </li>`;
    }).join('');

    if (estado.destacar) {
      const el = lista.querySelector('.item.destaque');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      estado.destacar = null;
    }
  }

  // Motivo do cancelamento: lista de motivos comuns + detalhe opcional
  const MOTIVOS_CANCELAMENTO = ['Cliente desistiu', 'Cliente não compareceu', 'Remarcado para outro dia', 'Chuva / clima',
    'Pet doente ou em tratamento', 'Indisponibilidade da equipe', 'Outro'];
  async function pedirMotivo(a) {
    const caixa = document.createElement('div');
    caixa.className = 'motivo-cancel';
    caixa.innerHTML = `
      <label class="obrig"><span>Motivo do cancelamento <span class="ast" aria-hidden="true">*</span></span>
        <select id="m-motivo"><option value="">Escolha o motivo…</option>${MOTIVOS_CANCELAMENTO.map((m) => `<option>${esc(m)}</option>`).join('')}</select></label>
      <label>Detalhe (opcional)<textarea id="m-detalhe" rows="2" maxlength="400" placeholder="Ex.: vai trazer na próxima semana"></textarea></label>
      <p class="erro-texto" id="m-erro" role="alert"></p>`;
    let resposta = null;
    const ok = await janela({
      titulo: 'Cancelar agendamento',
      texto: `Cancelar o horário de ${a.pet_nome} às ${hhmm(a.horario)}? O horário fica livre.`,
      extra: caixa,
      botoes: [
        { rotulo: 'Voltar', valor: false },
        { rotulo: 'Cancelar horário', classe: 'btn-perigo', valor: true, validar: () => {
          const m = caixa.querySelector('#m-motivo').value;
          const d = caixa.querySelector('#m-detalhe').value.trim();
          if (!m) { caixa.querySelector('#m-erro').textContent = 'Escolha o motivo do cancelamento.'; caixa.querySelector('#m-motivo').focus(); return false; }
          if (m === 'Outro' && !d) { caixa.querySelector('#m-erro').textContent = 'Descreva o motivo no campo Detalhe.'; caixa.querySelector('#m-detalhe').focus(); return false; }
          resposta = (d ? `${m}: ${d}` : m).slice(0, 500);
          return true;
        } }
      ]
    });
    return ok ? resposta : null;
  }

  // ---------------------------------------------------------------
  // Leva e traz do dia: buscas e entregas em ordem, com rota no mapa
  // ---------------------------------------------------------------
  const temLeva = (a) => a.status !== 'cancelado' && (a.busca_domicilio || a.entrega_domicilio);
  function atualizarBotaoLeva() {
    const n = (estado.itensDia || []).filter(temLeva).length;
    $('#btn-leva').hidden = !n || estado.visao === 'semana';
    $('#leva-qtd').textContent = n ? `(${n})` : '';
    if (!$('#aba-passeio').hidden) montarLeva($('#passeio-leva'));
  }
  const endBusca = (a) => ({ rua: a.end_rua, numero: a.end_numero, bairro: a.end_bairro, cidade: a.end_cidade, cep: a.end_cep, ref: a.end_referencia });
  const endEntrega = (a) => (a.entrega_outro_end
    ? { rua: a.ent_rua, numero: a.ent_numero, bairro: a.ent_bairro, cidade: a.ent_cidade, cep: a.ent_cep, ref: a.ent_referencia }
    : endBusca(a));
  const textoEnd = (e) => [e.rua && `${e.rua}, ${e.numero || 's/n'}`, e.bairro, e.cidade].filter(Boolean).join(' – ');
  const consultaMapa = (e) => enderecoParaMapa(e.rua, e.numero, e.bairro, e.cidade, e.cep);

  // Navegação sempre a partir de onde o celular está (o app de GPS usa a localização atual)
  const MAX_PARADAS = 10;                         // limite do Google Maps: destino + 9 paradas
  function linkRota(enderecos) {
    if (!enderecos.length) return '';
    const lista = enderecos.slice(0, MAX_PARADAS);
    const p = new URLSearchParams({ api: '1', destination: lista[lista.length - 1], travelmode: 'driving' });
    if (lista.length > 1) p.set('waypoints', lista.slice(0, -1).join('|'));
    return 'https://www.google.com/maps/dir/?' + p.toString();
  }
  const linkGoogle = (e) => 'https://www.google.com/maps/dir/?' + new URLSearchParams({ api: '1', destination: consultaMapa(e), travelmode: 'driving' }).toString();
  const linkWaze = (e) => 'https://waze.com/ul?' + new URLSearchParams({ q: consultaMapa(e), navigate: 'yes' }).toString();

  // Ordem escolhida pelo usuário (fica salva neste aparelho, por dia)
  const chaveOrdem = (tipo) => `agendaPet.ordem.${tipo}.${estado.diaAgenda}`;
  function lerOrdem(tipo) { try { return JSON.parse(localStorage.getItem(chaveOrdem(tipo)) || '[]'); } catch (e) { return []; } }
  function gravarOrdem(tipo, ids) { try { localStorage.setItem(chaveOrdem(tipo), JSON.stringify(ids)); } catch (e) { /* sem armazenamento: vale só enquanto a tela estiver aberta */ } }
  const ordemMemoria = {};
  function ordenar(tipo, itens) {
    const salva = ordemMemoria[chaveOrdem(tipo)] || lerOrdem(tipo);
    const pos = (a) => { const i = salva.indexOf(a.id); return i < 0 ? 1e6 : i; };
    return itens.slice().sort((x, y) => pos(x) - pos(y) || x.horario.localeCompare(y.horario));
  }
  function moverLeva(tipo, id, passo) {
    const itens = ordenar(tipo, (estado.itensDia || []).filter(temLeva).filter((a) => (tipo === 'busca' ? a.busca_domicilio : a.entrega_domicilio)));
    const ids = itens.map((a) => a.id);
    const i = ids.indexOf(id), j = i + passo;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    ordemMemoria[chaveOrdem(tipo)] = ids;
    gravarOrdem(tipo, ids);
    abrirLeva(`${tipo}:${id}`);
  }
  function ordemPorHorario(tipo) {
    delete ordemMemoria[chaveOrdem(tipo)];
    try { localStorage.removeItem(chaveOrdem(tipo)); } catch (e) { /* ok */ }
    abrirLeva();
  }

  // ---------------------------------------------------------------
  // Melhor rota planejada pelo sistema (menos km = menos combustível)
  // Endereço -> ponto no mapa: OpenStreetMap (Nominatim). Melhor ordem pelas
  // ruas reais: OSRM. Sai da clínica e volta para a clínica. Grátis, sem chave;
  // só os endereços são enviados (nunca nome de tutor, pet ou telefone).
  // ---------------------------------------------------------------
  const CLINICA = { rua: 'Avenida Paulista', numero: '1000', bairro: 'Bela Vista', cidade: 'São Paulo/SP', cep: '01310100' };
  const GEO_URL = 'https://nominatim.openstreetmap.org/search';
  const ROTA_URL = 'https://router.project-osrm.org/trip/v1/driving/';
  const AMPLO = new Set(['city', 'town', 'village', 'municipality', 'county', 'state', 'state_district', 'region', 'country']);
  const geoMemoria = {};
  let geoFila = Promise.resolve(), geoUltimo = 0;
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  const chaveGeo = (e) => 'agendaPet.geo.' + [e.rua, e.numero, e.bairro, e.cidade, soDigitos(e.cep)].map((x) => String(x || '').trim().toLowerCase()).join('|');
  function separarCidade(cidade) {
    const m = String(cidade || '').match(/^(.*?)\s*[/-]\s*([A-Za-z]{2})$/);
    return m ? [m[1].trim(), m[2].toUpperCase()] : [String(cidade || '').trim(), ''];
  }
  const ESTADOS = { AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal',
    ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará',
    PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul',
    RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins' };
  const PHOTON_URL = 'https://photon.komoot.io/api/';
  // por que o mapa falhou (para a mensagem dizer o motivo certo)
  const falhaMapa = { rede: 0, bloqueado: false, detalhe: '' };
  document.addEventListener('securitypolicyviolation', (ev) => {
    if (!/nominatim|osrm|photon/.test(ev.blockedURI || '')) return;
    falhaMapa.bloqueado = true;
    let host = ev.blockedURI;
    try { host = new URL(ev.blockedURI).host; } catch (er) { /* fica o texto */ }
    const regra = (String(ev.originalPolicy || '').match(/connect-src[^;]*/) || [''])[0];
    const versaoRegra = /photon/.test(regra) ? 'v33' : /nominatim/.test(regra) ? 'v32' : 'antiga (sem mapas)';
    falhaMapa.detalhe = `Detalhe: bloqueou ${host} · regra do site no aparelho: ${versaoRegra}.`;
  });
  async function pegarJson(url) {
    let r;
    try { r = await fetch(url, { headers: { Accept: 'application/json' } }); } catch (er) { falhaMapa.rede++; throw er; }
    if (!r.ok) { falhaMapa.rede++; throw new Error('mapa ' + r.status); }
    return r.json();
  }
  // resultado só vale se não for a cidade inteira e se for do estado certo (há cidades com o mesmo nome em estados diferentes)
  const estadoConfere = (uf, nome, iso) => !uf || iso === 'BR-' + uf || semAcento(String(nome || '').trim()) === semAcento(ESTADOS[uf] || uf);
  // OpenStreetMap (Nominatim): uma consulta por vez e no máximo 1 por segundo (regra de uso)
  function geoPedir(params, uf) {
    const vez = geoFila.then(async () => {
      const falta = geoUltimo + 1100 - Date.now();
      if (falta > 0) await esperar(falta);
      geoUltimo = Date.now();
      const q = new URLSearchParams({ format: 'jsonv2', limit: '3', addressdetails: '1', countrycodes: 'br', 'accept-language': 'pt-BR', ...params });
      const lista = await pegarJson(`${GEO_URL}?${q}`);
      const x = (Array.isArray(lista) ? lista : []).find((r) => !AMPLO.has(r.addresstype)
        && estadoConfere(uf, r.address && r.address.state, r.address && r.address['ISO3166-2-lvl4']));
      const pos = x ? [Number(x.lon), Number(x.lat)] : null;
      return pos && pos.every(Number.isFinite) ? pos : null;
    });
    geoFila = vez.catch(() => {});
    return vez;
  }
  // reserva: Photon (também OpenStreetMap, aceita erros de digitação e acentos)
  async function photonPedir(texto, uf) {
    const q = new URLSearchParams({ q: texto, limit: '3', lat: '-23.98', lon: '-48.88' });
    const j = await pegarJson(`${PHOTON_URL}?${q}`);
    const f = ((j && j.features) || []).find((x) => {
      const pr = x.properties || {};
      return pr.countrycode === 'BR' && !AMPLO.has(pr.type) && !['city', 'county', 'state', 'country', 'district'].includes(pr.type) && estadoConfere(uf, pr.state);
    });
    const pos = f && f.geometry && f.geometry.coordinates;
    return pos && pos.length === 2 && pos.every(Number.isFinite) ? [pos[0], pos[1]] : null;
  }
  const geoAndamento = {};
  function localizar(e) {
    const k = chaveGeo(e);
    if (k in geoMemoria) return Promise.resolve(geoMemoria[k]);
    if (!geoAndamento[k]) geoAndamento[k] = localizarAgora(e, k).finally(() => { delete geoAndamento[k]; });
    return geoAndamento[k];
  }
  async function localizarAgora(e, k) {
    try { const salvo = JSON.parse(localStorage.getItem(k) || 'null'); if (salvo) return (geoMemoria[k] = salvo); } catch (er) { /* ok */ }
    const [cid0, uf0] = separarCidade(e.cidade || CLINICA.cidade);
    const cid = cid0 || 'São Paulo', uf = uf0 || 'SP', estado = ESTADOS[uf] || uf;
    const rua = String(e.rua || '').trim(), num = String(e.numero || '').trim(), cep = soDigitos(e.cep);
    const tentativas = [];
    if (rua) {
      tentativas.push(() => geoPedir({ q: `${rua}${num ? ' ' + num : ''}, ${cid}, ${estado}, Brasil` }, uf));
      tentativas.push(() => photonPedir(`${rua}${num ? ' ' + num : ''}, ${cid}, ${estado}`, uf));
      tentativas.push(() => geoPedir({ street: rua, city: cid, state: estado, country: 'Brasil' }, uf));
    }
    if (cep.length === 8) tentativas.push(() => geoPedir({ postalcode: `${cep.slice(0, 5)}-${cep.slice(5)}`, country: 'Brasil' }, uf));
    if (e.bairro) tentativas.push(() => photonPedir(`${e.bairro}, ${cid}, ${estado}`, uf));
    let pos = null, erros = 0, feitas = 0;
    for (const t of tentativas) {
      try { pos = await t(); } catch (er) { erros++; }
      feitas++;
      if (pos) break;
      if (erros >= 2 && erros === feitas) break;                       // os dois serviços sem resposta: desiste logo
    }
    if (!pos && erros === feitas) throw new Error('sem conexão com o mapa');   // nada respondeu: não guarda
    geoMemoria[k] = pos;                                               // não achado: tenta de novo só na próxima abertura
    if (pos) try { localStorage.setItem(k, JSON.stringify(pos)); } catch (er) { /* ok */ }
    return pos;
  }
  // melhor ordem pelas ruas (pontos[0] = clínica, ida e volta)
  async function ordemPelasRuas(pontos) {
    const coords = pontos.map(([lo, la]) => `${lo.toFixed(6)},${la.toFixed(6)}`).join(';');
    const r = await fetch(`${ROTA_URL}${coords}?roundtrip=true&source=first&overview=false&steps=false`);
    if (!r.ok) throw new Error('rota ' + r.status);
    const j = await r.json();
    if (j.code !== 'Ok' || !Array.isArray(j.waypoints) || j.waypoints.length !== pontos.length || (j.trips || []).length !== 1) throw new Error('rota');
    return j.waypoints.map((w, i) => [w.waypoint_index, i]).sort((x, y) => x[0] - y[0]).map(([, i]) => i).filter((i) => i !== 0);
  }
  // reserva, se o serviço de ruas não responder: vizinho mais próximo + 2-opt em linha reta
  function ordemLinhaReta(pontos) {
    const d = ([lo1, la1], [lo2, la2]) => {
      const r = Math.PI / 180, a = Math.sin((la2 - la1) * r / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin((lo2 - lo1) * r / 2) ** 2;
      return 2 * 6371 * Math.asin(Math.sqrt(a));
    };
    const resta = pontos.map((_, i) => i).slice(1), volta = [0];
    while (resta.length) {
      const ult = pontos[volta[volta.length - 1]];
      let m = 0; resta.forEach((i, k) => { if (d(ult, pontos[i]) < d(ult, pontos[resta[m]])) m = k; });
      volta.push(resta.splice(m, 1)[0]);
    }
    volta.push(0);
    for (let melhorou = true; melhorou;) {
      melhorou = false;
      for (let i = 1; i < volta.length - 2; i++) for (let k = i + 1; k < volta.length - 1; k++) {
        const [a, b, c, e] = [volta[i - 1], volta[i], volta[k], volta[k + 1]].map((x) => pontos[x]);
        if (d(a, c) + d(b, e) < d(a, b) + d(c, e) - 1e-9) { volta.splice(i, k - i + 1, ...volta.slice(i, k + 1).reverse()); melhorou = true; }
      }
    }
    return volta.slice(1, -1);
  }

  const chavePlano = (tipo) => `agendaPet.plano.${tipo}.${estado.diaAgenda}`;
  const planoMemoria = {}, planejando = {}, tentouAuto = new Set();
  function lerPlano(tipo) {
    const k = chavePlano(tipo);
    if (k in planoMemoria) return planoMemoria[k];
    try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; }
  }
  function gravarPlano(tipo, plano) {
    planoMemoria[chavePlano(tipo)] = plano;
    try { localStorage.setItem(chavePlano(tipo), JSON.stringify(plano)); } catch (e) { /* vale enquanto a tela estiver aberta */ }
  }
  const pendenteLeva = (tipo) => (a) => (tipo === 'busca' ? a.status === 'agendado' : a.status !== 'entregue');
  const itensDoTipo = (tipo) => (estado.itensDia || []).filter(temLeva)
    .filter((a) => (tipo === 'busca' ? a.busca_domicilio : a.entrega_domicilio))
    .sort((x, y) => x.horario.localeCompare(y.horario));
  // 'sem' (sem plano), 'ok' (seguindo o plano), 'mudou' (motorista mudou), 'velho' (entrou pet novo), 'carregando'
  function situacaoPlano(tipo, lista) {
    if (planejando[chavePlano(tipo)]) return 'carregando';
    const p = lerPlano(tipo);
    if (!p) return 'sem';
    const pend = lista.filter(pendenteLeva(tipo)).map((a) => a.id);
    if (pend.some((id) => !p.ids.includes(id))) return 'velho';
    const noPlano = p.ids.filter((id) => pend.includes(id));
    return lista.map((a) => a.id).filter((id) => pend.includes(id)).join() === noPlano.join() ? 'ok' : 'mudou';
  }
  function redesenharLeva() {
    if (!$('#aba-passeio').hidden) montarLeva($('#passeio-leva'));
    else if (!$('#painel-leva').hidden) montarLeva($('#leva-corpo'));
  }
  async function planejarRota(tipo, auto) {
    const k = chavePlano(tipo), dia = estado.diaAgenda;
    if (planejando[k]) return;
    const itens = itensDoTipo(tipo), endDe = tipo === 'busca' ? endBusca : endEntrega;
    const pend = itens.filter(pendenteLeva(tipo));
    if (pend.length < 2) { if (!auto) toast('É preciso ter pelo menos 2 paradas para planejar a rota.', 'erro'); return; }
    planejando[k] = true; redesenharLeva();
    try {
      falhaMapa.rede = 0;
      const tentar = (e) => localizar(e).catch(() => null);
      const clinica = await tentar(CLINICA);
      if (!clinica && falhaMapa.rede >= 2) throw new Error('sem conexão com o mapa');
      const pos = [];
      for (const a of pend) pos.push(await tentar(endDe(a)));
      const achados = pend.filter((a, i) => pos[i]), pts = pos.filter(Boolean);
      if (!achados.length) throw new Error('nenhum endereço achado');
      const origem = clinica || [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
      let ordem = [1];
      if (achados.length > 1) {
        const pontos = [origem, ...pts];
        try { ordem = await ordemPelasRuas(pontos); } catch (e) { ordem = ordemLinhaReta(pontos); }
      }
      if (estado.diaAgenda !== dia) return;                            // trocou de dia no meio: descarta
      const ids = ordem.map((i) => achados[i - 1].id);
      const naoLocal = pend.filter((a) => !ids.includes(a.id)).map((a) => a.id);
      const final = [...ids, ...naoLocal, ...itens.filter((a) => !pend.includes(a)).map((a) => a.id)];
      gravarPlano(tipo, { ids: final, naoLocal });
      ordemMemoria[chaveOrdem(tipo)] = final;
      gravarOrdem(tipo, final);
      if (!auto) toast('Melhor rota planejada.', 'ok');
      if (naoLocal.length) toast(`${naoLocal.length} endereço(s) não foram achados no mapa e ficaram no fim da lista. Confira a ordem deles.`, 'erro');
    } catch (e) {
      if (!auto) {
        toast(falhaMapa.bloqueado
          ? `O site bloqueou o acesso ao mapa. Feche e abra o app de novo; se continuar, mande um print desta mensagem. ${falhaMapa.detalhe}`
          : falhaMapa.rede
            ? 'Não consegui falar com o serviço de mapas (sem internet ou serviço fora do ar). Tente de novo em instantes.'
            : 'O mapa não encontrou os endereços destes pets. Confira rua, número e cidade no cadastro.', 'erro');
      }
    } finally {
      delete planejando[k];
      redesenharLeva();
    }
  }
  // planeja sozinho quando ainda não há plano (ou entrou pet novo) e o motorista não mexeu na ordem
  function planejarSozinho(tipo) {
    const lista = itensDoTipo(tipo), pend = lista.filter(pendenteLeva(tipo));
    if (pend.length < 2) return;
    const sit = situacaoPlano(tipo, lista);
    if (sit !== 'sem' && sit !== 'velho') return;
    const p = lerPlano(tipo), salva = ordemMemoria[chaveOrdem(tipo)] || lerOrdem(tipo);
    if (!p && salva.length) return;                                    // já tinha ordem própria do motorista
    if (p) {                                                           // pet novo: só replaneja se ele seguia o plano
      const ordenados = ordenar(tipo, lista).map((a) => a.id).filter((id) => p.ids.includes(id) && pend.some((a) => a.id === id));
      if (ordenados.join() !== p.ids.filter((id) => ordenados.includes(id)).join()) return;
    }
    const assinatura = `${chavePlano(tipo)}|${pend.map((a) => a.id).sort().join()}`;
    if (tentouAuto.has(assinatura)) return;
    tentouAuto.add(assinatura);
    planejarRota(tipo, true);
  }
  function voltarAoPlano(tipo) {
    const p = lerPlano(tipo);
    if (!p) return;
    ordemMemoria[chaveOrdem(tipo)] = p.ids.slice();
    gravarOrdem(tipo, p.ids);
    abrirLeva();
  }
  function avisoPlano(tipo, lista) {
    if (lista.filter(pendenteLeva(tipo)).length < 2) return '';
    const sit = situacaoPlano(tipo, lista);
    if (sit === 'carregando') return '<div class="lv-plano lv-plano-carregando" role="status"><span class="lv-giro" aria-hidden="true"></span> Planejando a melhor rota…</div>';
    if (sit === 'ok') return `<div class="lv-plano lv-plano-ok"><span><b>⭐ Rota recomendada</b> · a ordem mais econômica, planejada pelo sistema (sai e volta para a clínica). Se precisar, mude com ▲▼.</span>
        <button class="link-btn" data-planejar="${tipo}">↻ Replanejar</button></div>`;
    if (sit === 'mudou') return `<div class="lv-plano lv-plano-mudou"><span><b>✋ Ordem alterada por você.</b> A melhor rota é a recomendada pelo sistema.</span>
        <button class="btn btn-pequeno btn-plano" data-voltar-plano="${tipo}">⭐ Voltar para a rota recomendada</button></div>`;
    if (sit === 'velho') return `<div class="lv-plano lv-plano-mudou"><span><b>🆕 Entrou pet novo</b> depois do planejamento.</span>
        <button class="btn btn-pequeno btn-plano" data-planejar="${tipo}">✨ Replanejar melhor rota</button></div>`;
    return `<div class="lv-plano"><button class="btn btn-pequeno btn-plano" data-planejar="${tipo}">✨ Planejar melhor rota</button></div>`;
  }

  const situacaoBusca = (a) => (a.status === 'agendado' ? ['A buscar', 'lv-pendente'] : ['Já está na loja', 'lv-ok']);
  const situacaoEntrega = (a) => (a.status === 'entregue' ? ['Entregue ✓', 'lv-ok'] : a.status === 'finalizado' ? ['Pronto para entregar', 'lv-pronto']
    : a.status === 'em_banho' ? ['No banho', 'lv-banho'] : ['Aguardando banho', 'lv-pendente']);
  function cartaoLeva(tipo, a, e, [sit, cls], n, total, naoAchado) {
    const tel = a.telefone ? `<a class="lv-tel sem-quebra" href="tel:+55${soDigitos(a.telefone)}">📞 ${esc(formatarTelefone(a.telefone))}</a>` : '';
    return `<li class="lv-item" data-lv="${tipo}:${esc(a.id)}">
      <div class="lv-ordem">
        <button class="lv-seta" data-mover="${tipo}" data-id="${esc(a.id)}" data-passo="-1" aria-label="Subir ${esc(a.pet_nome)}"${n === 1 ? ' disabled' : ''}>▲</button>
        <span class="lv-num">${n}º</span>
        <button class="lv-seta" data-mover="${tipo}" data-id="${esc(a.id)}" data-passo="1" aria-label="Descer ${esc(a.pet_nome)}"${n === total ? ' disabled' : ''}>▼</button>
      </div>
      <div class="lv-info">
        <div><span class="lv-hora">${hhmm(a.horario)}</span> <b>${esc(a.pet_nome)}</b> · tutor ${esc(a.tutor_nome)} <span class="tag ${cls}">${sit}</span></div>
        <div class="lv-end">${ICONE_PINO}<span>${esc(textoEnd(e))}${e.ref ? `<br><i>Ref.: ${esc(e.ref)}</i>` : ''}</span></div>
        ${naoAchado ? '<div class="lv-naoachado">📍 Endereço não achado no mapa: confira a posição deste pet na rota.</div>' : ''}
        <div class="lv-acoes">${tel}
          <a class="lv-nav lv-google" target="_blank" rel="noopener" href="${linkGoogle(e)}">Google Maps</a>
          <a class="lv-nav lv-waze" target="_blank" rel="noopener" href="${linkWaze(e)}">Waze</a>
        </div>
      </div></li>`;
  }
  function secaoLeva(tipo, itens, endDe, situacao, prontos, titulo, classeRota, rotuloRota) {
    const lista = ordenar(tipo, itens);
    const paradas = lista.filter(prontos).map((a) => consultaMapa(endDe(a)));
    // buscas: depois de pegar os pets o GPS termina na clínica; entregas: termina no último endereço
    const volta = tipo === 'busca';
    const cabem = volta ? MAX_PARADAS - 1 : MAX_PARADAS;
    const rota = linkRota(volta && paradas.length ? [...paradas.slice(0, cabem), consultaMapa(CLINICA)] : paradas);
    const salva = !!(ordemMemoria[chaveOrdem(tipo)] || lerOrdem(tipo).length);
    const naoAchados = (lerPlano(tipo) || {}).naoLocal || [];
    return `<section class="lv-secao">
      <div class="lv-secao-cab"><h4>${titulo} <small>(${lista.length})</small></h4>
        ${rota ? `<a class="btn ${classeRota} btn-pequeno" target="_blank" rel="noopener" href="${rota}">${rotuloRota} (${Math.min(paradas.length, cabem)})</a>` : ''}</div>
      ${avisoPlano(tipo, lista)}
      ${lista.length ? `<ol class="lv-lista">${lista.map((a, i) => cartaoLeva(tipo, a, endDe(a), situacao(a), i + 1, lista.length, naoAchados.includes(a.id) && pendenteLeva(tipo)(a))).join('')}</ol>` : '<p class="nota">Nenhuma hoje.</p>'}
      ${paradas.length > cabem ? `<p class="nota lv-aviso">O Google Maps aceita até ${MAX_PARADAS} paradas por rota: a rota leva as ${cabem} primeiras da lista${volta ? ' e termina na clínica' : ''}.</p>` : ''}
      ${salva && lista.length > 1 ? `<button class="link-btn lv-restaurar" data-restaurar="${tipo}">Voltar para a ordem por horário</button>` : ''}
    </section>`;
  }
  // monta as listas de busca/entrega dentro de um painel (janela no PC ou aba Passeio no celular)
  function montarLeva(alvo, focar) {
    const itens = (estado.itensDia || []).filter(temLeva);
    const buscas = itens.filter((a) => a.busca_domicilio);
    const entregas = itens.filter((a) => a.entrega_domicilio);
    const resumo = `${buscas.length} busca(s) e ${entregas.length} entrega(s)`;
    $('#leva-sub').textContent = `${diaPorExtenso(estado.diaAgenda)} · ${resumo}`;
    $('#ps-resumo').textContent = itens.length ? `Leva e traz: ${resumo}` : '';
    alvo.innerHTML = !itens.length && alvo.id === 'passeio-leva'
      ? '<p class="vazio">Nenhuma busca ou entrega em casa neste dia.</p>'
      : secaoLeva('busca', buscas, endBusca, situacaoBusca, (a) => a.status === 'agendado', '🏠➜🐾 Buscar em casa', 'btn-primario', 'Rota das buscas → clínica')
        + secaoLeva('entrega', entregas, endEntrega, situacaoEntrega, (a) => a.status === 'finalizado', '🐾➜🏠 Entregar em casa', 'btn-entregar', 'Rota das entregas prontas')
        + `<p class="nota lv-dica">O sistema planeja sozinho a melhor rota (menos quilômetros e menos combustível), saindo e voltando para a clínica.
           Se precisar, mude a ordem com ▲▼; as rotas seguem essa ordem e saem de onde o celular estiver (a ordem fica salva neste aparelho).
           Na rota entram as buscas ainda não feitas e as entregas com banho finalizado. Em cada pet, "Google Maps" ou "Waze" abre a navegação só até aquele endereço.</p>`;
    if (itens.length) { planejarSozinho('busca'); planejarSozinho('entrega'); }
    if (typeof focar !== 'string' && estado.focarLeva && alvo.id === 'passeio-leva' && itens.some((a) => estado.focarLeva.endsWith(':' + a.id))) {
      focar = estado.focarLeva; estado.focarLeva = null;
    }
    if (typeof focar === 'string') {
      const [tipo, id] = focar.split(':');
      const el = [...alvo.querySelectorAll('.lv-item')].find((li) => li.dataset.lv === `${tipo}:${id}`);
      if (el) { el.classList.add('lv-movido'); el.scrollIntoView({ block: 'nearest' }); }
    }
  }
  function abrirLeva(focar) {
    if (!$('#aba-passeio').hidden) return montarLeva($('#passeio-leva'), focar);
    montarLeva($('#leva-corpo'), focar);
    $('#painel-leva').hidden = false;
  }
  ['#leva-corpo', '#passeio-leva'].forEach((sel) => $(sel).addEventListener('click', (e) => {
    const m = e.target.closest('[data-mover]');
    if (m) return moverLeva(m.dataset.mover, m.dataset.id, Number(m.dataset.passo));
    const r = e.target.closest('[data-restaurar]');
    if (r) return ordemPorHorario(r.dataset.restaurar);
    const pl = e.target.closest('[data-planejar]');
    if (pl) return planejarRota(pl.dataset.planejar, false);
    const vp = e.target.closest('[data-voltar-plano]');
    if (vp) return voltarAoPlano(vp.dataset.voltarPlano);
  }));

  // ---------------------------------------------------------------
  // Aba Passeio (celular): busca + leva e traz do dia
  // ---------------------------------------------------------------
  const ehCelular = window.matchMedia('(max-width: 640px)');
  function posicionarBusca() {
    const busca = $('.busca-agenda'), resultado = $('#resultado-busca');
    if (ehCelular.matches) {
      $('#passeio-busca-slot').append(busca, resultado);
      $('#busca-agenda').placeholder = 'Leva e traz: pet, tutor ou celular';
    } else {
      const painel = $('.painel-agenda');
      $('#busca-agenda').placeholder = 'Buscar pet, tutor ou telefone';
      painel.insertBefore(busca, painel.firstChild);
      painel.appendChild(resultado);
      if (!$('#aba-passeio').hidden) $('[data-aba="agenda"]').click();   // Passeio é só do celular
    }
  }
  try { ehCelular.addEventListener('change', posicionarBusca); } catch (e) { /* navegador antigo */ }
  posicionarBusca();
  function abrirPasseio() {
    if (estado.visao === 'semana') $('[data-visao="dia"]').click();      // o passeio é sempre de um dia
    $('#ps-titulo').textContent = diaPorExtenso(estado.diaAgenda);
    $('#ps-data').textContent = isoParaBR(estado.diaAgenda);
    montarLeva($('#passeio-leva'));
    carregarDia();                                                       // garante dados atualizados
  }
  $('#ps-anterior').addEventListener('click', () => irParaDia(somarDias(estado.diaAgenda, -1)));
  $('#ps-seguinte').addEventListener('click', () => irParaDia(somarDias(estado.diaAgenda, 1)));
  $('#ps-hoje').addEventListener('click', () => irParaDia(hojeISO()));
  $('#btn-leva').addEventListener('click', () => abrirLeva());
  $('#leva-fechar').addEventListener('click', () => { $('#painel-leva').hidden = true; });
  $('#painel-leva').addEventListener('click', (e) => { if (e.target.id === 'painel-leva') $('#painel-leva').hidden = true; });

  // ações da lista
  $('#lista-agenda').addEventListener('click', async (e) => {
    // celular: botão "Mais" abre/fecha as ações secundárias do cartão
    const mais = e.target.closest('[data-mais]');
    if (mais) {
      const li = mais.closest('.item');
      const aberto = li.classList.toggle('mais-aberto');
      mais.setAttribute('aria-expanded', aberto);
      mais.textContent = aberto ? 'Menos ▴' : 'Mais ▾';
      return;
    }
    const b = e.target.closest('[data-acao]');
    if (!b) return;
    const a = estado.itensDia.find((x) => x.id === b.dataset.id);
    if (!a) return;
    const acao = b.dataset.acao;

    if (acao === 'editar') return preencherForm(a);

    if (acao === 'iniciar') {
      const { error } = await sb.from('agendamentos').update({ status: 'em_banho' }).eq('id', a.id);
      if (error) return toast('Não foi possível iniciar o banho.', 'erro');
      toast(`${a.pet_nome} está no banho.`, 'ok');
      return carregarDia();
    }

    if (acao === 'finalizar') {
      const ok = await confirmar('Finalizar banho', `Confirmar que o banho de ${a.pet_nome} terminou?` +
        (a.telefone ? '\nO tutor será avisado pelo WhatsApp.' : '\nNão há telefone cadastrado para avisar o tutor.'), 'Finalizar', 'btn-ok');
      if (!ok) return;
      const { error } = await sb.from('agendamentos').update({ status: 'finalizado' }).eq('id', a.id);
      if (error) return toast('Não foi possível finalizar.', 'erro');
      toast(`${a.pet_nome} finalizado.`, 'ok');
      if (a.telefone) avisarTutor(a);
      return carregarDia();
    }

    if (acao === 'avisar') return avisarTutor(a);

    if (acao === 'entregar') {
      const ok = await confirmar('Entregue ao tutor', `Confirmar que ${a.pet_nome} foi retirado(a) por ${a.tutor_nome}?`, 'Confirmar entrega', 'btn-entregar');
      if (!ok) return;
      const { error } = await sb.from('agendamentos').update({ status: 'entregue' }).eq('id', a.id);
      if (error) return toast('Não foi possível registrar a entrega.', 'erro');
      toast(`${a.pet_nome} entregue ao tutor.`, 'ok');
      return carregarDia();
    }

    if (acao === 'desfazer-entrega') {
      const ok = await confirmar('Desfazer entrega', `${a.pet_nome} volta para "Finalizado" (aguardando retirada).`, 'Desfazer', 'btn-primario');
      if (!ok) return;
      const { error } = await sb.from('agendamentos').update({ status: 'finalizado' }).eq('id', a.id);
      if (error) return toast('Não foi possível desfazer a entrega.', 'erro');
      return carregarDia();
    }

    if (acao === 'cancelar') {
      const motivo = await pedirMotivo(a);
      if (motivo === null) return;
      const { error } = await sb.from('agendamentos').update({ status: 'cancelado', motivo_cancelamento: motivo }).eq('id', a.id);
      if (error) return toast('Não foi possível cancelar.', 'erro');
      toast('Agendamento cancelado.');
      return carregarDia();
    }

    if (acao === 'reabrir') {
      const { error } = await sb.from('agendamentos').update({ status: 'agendado' }).eq('id', a.id);
      if (error) {
        if (error.code === '23505') return conflito(a.data, hhmm(a.horario));
        return toast('Não foi possível reabrir.', 'erro');
      }
      return carregarDia();
    }

    if (acao === 'excluir') {
      const ok = await confirmar('Excluir definitivamente', `Excluir o registro de ${a.pet_nome}? Ele também sai dos gráficos. Esta ação não pode ser desfeita.`, 'Excluir', 'btn-perigo');
      if (!ok) return;
      const { error } = await sb.from('agendamentos').delete().eq('id', a.id);
      if (error) return toast('Não foi possível excluir.', 'erro');
      toast('Registro excluído.');
      return carregarDia();
    }
  });

  /* =================================================================
     Aviso de pet pronto (WhatsApp)
     ================================================================= */
  // Ajusta o texto pelo sexo do animal: "do(a)", "ele(a)", "pronto(a)"...
  //   Macho -> do, ele, pronto      Fêmea -> da, ela, pronta
  //   Sem sexo cadastrado -> mantém "do(a)", "ele(a)"...
  function generoTexto(txt, sexo) {
    if (sexo !== 'Macho' && sexo !== 'Fêmea') return txt;
    return txt.replace(/(\p{L}+)\(a\)/gu, (_, palavra) =>
      sexo === 'Macho' ? palavra : palavra.replace(/[oe]$/, 'a').replace(/[OE]$/, 'A'));
  }
  function textoAviso(a) {
    const texto = (C.MENSAGEM_PRONTO || '')
      .replaceAll('{tutor}', (a.tutor_nome || '').split(' ')[0])
      .replaceAll('{pet}', a.pet_nome || '')
      .replaceAll('{empresa}', C.NOME_EMPRESA_MENSAGEM || '');
    return generoTexto(texto, a.pet_sexo);
  }

  // Trava contra disparo repetido: pergunta antes de reenviar e ignora clique duplo
  const INTERVALO_AVISO_MIN = Number(C.AVISO_INTERVALO_MIN) || 10;
  const avisando = new Set();
  async function avisarTutor(a) {
    if (avisando.has(a.id)) return;
    if (a.aviso_enviado_em) {
      const min = (Date.now() - new Date(a.aviso_enviado_em).getTime()) / 60000;
      if (min < INTERVALO_AVISO_MIN) {
        const hora = new Date(a.aviso_enviado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        if (C.WHATSAPP_AUTOMATICO) {
          return janela({ titulo: 'Tutor já avisado', texto: `O tutor de ${a.pet_nome} foi avisado às ${hora}. Para evitar mensagens repetidas, aguarde ${INTERVALO_AVISO_MIN} minutos para reenviar.` });
        }
        const ok = await confirmar('Tutor já avisado', `O tutor de ${a.pet_nome} já foi avisado às ${hora}. Enviar de novo?`, 'Enviar de novo', 'btn-ok');
        if (!ok) return;
      }
    }
    avisando.add(a.id);
    try { await enviarAviso(a); } finally { avisando.delete(a.id); }
  }
  async function enviarAviso(a) {
    if (C.WHATSAPP_AUTOMATICO) {
      const { data, error } = await sb.functions.invoke('notificar-whatsapp', { body: { id: a.id } });
      if (!error && data && data.ok) { toast(`Aviso enviado para o tutor de ${a.pet_nome}.`, 'ok'); carregarDia(); return; }
      if (error && error.context && error.context.status === 429) {
        toast('Este tutor já foi avisado há poucos minutos. Aguarde para reenviar.', 'erro');
        return;
      }
      toast('Envio automático falhou. Use o WhatsApp Web.', 'erro');
    }
    const numero = `${C.DDI || '55'}${soDigitos(a.telefone)}`;
    const link = `https://wa.me/${numero}?text=${encodeURIComponent(textoAviso(a))}`;
    const abrir = await janela({
      titulo: 'Avisar o tutor',
      texto: `Mensagem para ${formatarTelefone(a.telefone)}:\n\n${textoAviso(a)}`,
      botoes: [{ rotulo: 'Agora não', valor: false }, { rotulo: 'Abrir WhatsApp', classe: 'btn-ok', valor: true }]
    });
    if (!abrir) return;
    window.open(link, '_blank', 'noopener');
    await sb.from('agendamentos').update({ aviso_enviado_em: new Date().toISOString() }).eq('id', a.id);
    carregarDia();
  }

  /* =================================================================
     Formulário de agendamento
     ================================================================= */
  const f = {
    id: $('#f-id'), data: $('#f-data'), horario: $('#f-horario'), tutor: $('#f-tutor'), telefone: $('#f-telefone'),
    pet: $('#f-pet'), idade: $('#f-idade'), saude: $('#f-saude'), peso: $('#f-peso'), raca: $('#f-raca'), obs: $('#f-obs'),
    busca: $('#f-busca'), entrega: $('#f-entrega'), cep: $('#f-cep'), rua: $('#f-rua'), numero: $('#f-numero'),
    bairro: $('#f-bairro'), cidade: $('#f-cidade'), referencia: $('#f-referencia'),
    outroEnd: $('#f-outro-end'), entCep: $('#f-ent-cep'), entRua: $('#f-ent-rua'), entNumero: $('#f-ent-numero'),
    entBairro: $('#f-ent-bairro'), entCidade: $('#f-ent-cidade'), entReferencia: $('#f-ent-referencia')
  };

  // ---------------------------------------------------------------
  // Serviço (opcional): Banho, Tosa, ... + valor em R$
  // Para mudar a lista, dá para colocar SERVICOS: [...] no config.js
  // ---------------------------------------------------------------
  const SERVICOS = (Array.isArray(C.SERVICOS) && C.SERVICOS.length ? C.SERVICOS
    : ['Banho', 'Tosa', 'Banho + Tosa', 'Tosa higiênica', 'Banho + Tosa higiênica', 'Hidratação']).concat('Outro');
  $('#opcoes-servico').innerHTML = SERVICOS.map((sv) =>
    `<label class="opcao"><input type="radio" name="f-servico" value="${esc(sv)}"> ${esc(sv)}</label>`).join('');
  f.servicoOutro = $('#f-servico-outro');
  f.valor = $('#f-valor');
  const servicoMarcado = () => radio('f-servico');
  function mostrarServicoOutro() {
    const outro = servicoMarcado() === 'Outro';
    $('#ctl-servico-outro').hidden = !outro;
    if (!outro) f.servicoOutro.classList.remove('invalido');
  }
  $$('input[name="f-servico"]').forEach((r) => r.addEventListener('change', () => {
    mostrarServicoOutro();
    if (servicoMarcado() === 'Outro') f.servicoOutro.focus();
  }));
  // valor: só números e vírgula (ex.: 85,50)
  f.valor.addEventListener('input', () => {
    let v = f.valor.value.replace(/[^\d,]/g, '');
    const i = v.indexOf(',');
    if (i >= 0) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/,/g, '').slice(0, 2);
    f.valor.value = v;
  });
  const lerValor = () => {
    const t = f.valor.value.trim();
    if (!t) return null;
    const n = Number(t.replace(',', '.'));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
  };
  const dinheiro = (n) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const servicoEscolhido = () => (servicoMarcado() === 'Outro' ? nomeProprio(f.servicoOutro.value) : servicoMarcado()) || null;

  // ---------------------------------------------------------------
  // Leva e traz: endereço aparece quando a empresa busca e/ou entrega
  // ---------------------------------------------------------------
  const temTransporte = () => f.busca.checked || f.entrega.checked;
  // "Entregar em outro endereço" só faz sentido quando a empresa busca E entrega
  const temOutroEnd = () => f.busca.checked && f.entrega.checked && f.outroEnd.checked;
  function mostrarEndereco() {
    const ativo = temTransporte();
    $('#bloco-endereco').hidden = !ativo;
    $('#ctl-outro-end').hidden = !(f.busca.checked && f.entrega.checked);
    $('#bloco-endereco-entrega').hidden = !temOutroEnd();
    $('#tit-end-busca').textContent = temOutroEnd() ? 'Endereço de busca'
      : f.busca.checked && f.entrega.checked ? 'Endereço de busca e entrega'
      : f.busca.checked ? 'Endereço de busca' : 'Endereço de entrega';
    $('#dica-transporte').textContent =
      temOutroEnd() ? 'A empresa busca o pet em um endereço e entrega em outro (o tutor não estará no local da busca).'
      : f.busca.checked && f.entrega.checked ? 'A empresa busca e entrega o pet no mesmo endereço. Se o tutor não estiver em casa na volta, marque "Entregar em outro endereço".'
      : f.busca.checked ? 'A empresa busca o pet em casa; o tutor retira na loja.'
      : f.entrega.checked ? 'O tutor traz o pet; a empresa entrega em casa.'
      : 'Sem marcar nenhuma opção: o tutor traz e busca o pet.';
  }
  [f.busca, f.entrega].forEach((c) => c.addEventListener('change', () => {
    mostrarEndereco();
    if (temTransporte() && !f.cep.value && !f.rua.value) f.cep.focus();
  }));
  f.outroEnd.addEventListener('change', () => {
    mostrarEndereco();
    if (temOutroEnd() && !f.entCep.value && !f.entRua.value) f.entCep.focus();
  });

  // campo corrigido: tira o vermelho assim que a pessoa digita
  $('#form-agendamento').addEventListener('input', (e) => {
    if (e.target.matches('input, textarea') && e.target.value.trim()) e.target.classList.remove('invalido');
  });

  // CEP: máscara 00000-000 e busca automática no ViaCEP (serve para os dois endereços)
  function ligarCep(c) {
    const status = (txt, tipo = '') => { c.status.textContent = txt; c.status.className = `cep-status ${tipo}`; };
    let consultado = '', controle = null;
    async function buscar(cep) {
      if (cep === consultado) return;
      consultado = cep;
      if (controle) controle.abort();
      controle = new AbortController();
      status('Buscando endereço…');
      try {
        const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: controle.signal });
        const d = await r.json();
        if (soDigitos(c.cep.value) !== cep) return;               // a pessoa já mudou o CEP
        if (!r.ok || d.erro) { status('CEP não encontrado. Preencha o endereço manualmente.', 'erro'); c.rua.focus(); return; }
        if (d.logradouro) c.rua.value = d.logradouro;
        if (d.bairro) c.bairro.value = d.bairro;
        if (d.localidade) c.cidade.value = d.uf ? `${d.localidade}/${d.uf}` : d.localidade;
        c.rua.classList.remove('invalido');
        status(d.logradouro ? 'Endereço encontrado. Confira e informe o número.' : 'CEP geral da cidade: digite a rua.', 'ok');
        (d.logradouro ? c.numero : c.rua).focus();
      } catch (e) {
        if (e.name === 'AbortError') return;
        consultado = '';
        status('Não foi possível consultar o CEP agora. Preencha manualmente.', 'erro');
      }
    }
    c.cep.addEventListener('input', () => {
      const d = soDigitos(c.cep.value).slice(0, 8);
      c.cep.value = d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
      c.cep.classList.remove('invalido');
      if (d.length === 8) buscar(d);
      else { consultado = ''; status(''); }
    });
    // limpar(): esquece o CEP consultado; ao editar, marca o CEP atual como já consultado
    return { limpar() { consultado = ''; status(''); }, carregado() { consultado = soDigitos(c.cep.value); status(''); } };
  }
  const cepBusca = ligarCep({ cep: f.cep, rua: f.rua, numero: f.numero, bairro: f.bairro, cidade: f.cidade, status: $('#cep-status') });
  const cepEntrega = ligarCep({ cep: f.entCep, rua: f.entRua, numero: f.entNumero, bairro: f.entBairro, cidade: f.entCidade, status: $('#cep-status-ent') });
  mascaraData(f.data);
  mascaraHora(f.horario);
  f.telefone.addEventListener('input', () => { f.telefone.value = formatarTelefone(f.telefone.value); });
  f.idade.addEventListener('input', () => { f.idade.value = soDigitos(f.idade.value).slice(0, 2); });
  const fIdadeUn = $('#f-idade-un');
  function textoIdade() {
    const n = parseInt(f.idade.value, 10);
    if (!n && n !== 0) return null;
    if (fIdadeUn.value === 'meses') return n === 1 ? '1 mês' : `${n} meses`;
    return n === 1 ? '1 ano' : `${n} anos`;
  }
  function lerIdade(txt) {
    const m = /(\d{1,2})\s*(m)?/i.exec(txt || '');
    f.idade.value = m ? m[1] : '';
    fIdadeUn.value = m && m[2] ? 'meses' : 'anos';
  }
  f.peso.addEventListener('input', () => { f.peso.value = f.peso.value.replace(/[^\d,.]/g, '').replace('.', ','); });
  // ---------------------------------------------------------------
  // Calendário próprio: mostra só os dias do mês (1 a 28/29/30/31),
  // semana de domingo a sábado, "hoje" pelo horário de Brasília.
  // ---------------------------------------------------------------
  const MESES_CAL = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const SEMANA = [['dom.', 'domingo'], ['seg.', 'segunda-feira'], ['ter.', 'terça-feira'], ['qua.', 'quarta-feira'], ['qui.', 'quinta-feira'], ['sex.', 'sexta-feira'], ['sáb.', 'sábado']];
  const cal = $('#calendario');
  const btnCal = $('#btn-calendario');
  const ANO_MAX = Number(DATA_MAXIMA.slice(0, 4));
  let calMes = null;                         // { a: ano, m: mês 1-12 }

  const diasNoMes = (a, m) => new Date(a, m, 0).getDate();          // conta anos bissextos
  const isoDe = (a, m, d) => `${a}-${pad(m)}-${pad(d)}`;
  function minimoCal() {
    const hoje = hojeISO();
    return estado.dataOriginal && estado.dataOriginal < hoje ? estado.dataOriginal : hoje;
  }

  function desenharCal(focarDia) {
    const { a, m } = calMes;
    const min = minimoCal(), hoje = hojeISO(), escolhido = brParaISO(f.data.value);
    const [minA, minM] = min.split('-').map(Number);
    const total = diasNoMes(a, m);
    const inicio = new Date(a, m - 1, 1).getDay();                  // 0 = domingo
    const podeVoltar = a > minA || (a === minA && m > minM);
    const podeAvancar = a < ANO_MAX || m < 12;

    const opMes = MESES_CAL.map((nome, i) => {
      const fora = (a === minA && i + 1 < minM);
      return `<option value="${i + 1}"${i + 1 === m ? ' selected' : ''}${fora ? ' disabled' : ''}>${nome}</option>`;
    }).join('');
    let opAno = '';
    for (let y = minA; y <= ANO_MAX; y++) opAno += `<option value="${y}"${y === a ? ' selected' : ''}>${y}</option>`;

    let dias = '';
    for (let i = 0; i < inicio; i++) dias += '<span class="cal-vazio" aria-hidden="true"></span>';
    for (let d = 1; d <= total; d++) {
      const iso = isoDe(a, m, d);
      const bloqueado = iso < min || iso > DATA_MAXIMA;
      const dom = (inicio + d - 1) % 7 === 0;
      const cls = ['cal-dia', dom && 'cal-dom', iso === hoje && 'cal-hoje', iso === escolhido && 'cal-escolhido'].filter(Boolean).join(' ');
      const nomeDia = SEMANA[(inicio + d - 1) % 7][1];
      dias += `<button type="button" class="${cls}" data-iso="${iso}"${bloqueado ? ' disabled' : ''} tabindex="-1"
        aria-label="${nomeDia}, ${d} de ${MESES_CAL[m - 1]} de ${a}${iso === hoje ? ' (hoje)' : ''}"${iso === escolhido ? ' aria-pressed="true"' : ''}>${d}</button>`;
    }

    cal.innerHTML = `
      <div class="cal-topo">
        <button type="button" class="cal-nav" data-nav="-1" aria-label="Mês anterior"${podeVoltar ? '' : ' disabled'}>&#8249;</button>
        <select class="cal-mes" aria-label="Mês">${opMes}</select>
        <select class="cal-ano" aria-label="Ano">${opAno}</select>
        <button type="button" class="cal-nav" data-nav="1" aria-label="Próximo mês"${podeAvancar ? '' : ' disabled'}>&#8250;</button>
      </div>
      <div class="cal-semana" aria-hidden="true">${SEMANA.map(([l], i) => `<span${i === 0 ? ' class="cal-dom"' : ''}>${l}</span>`).join('')}</div>
      <div class="cal-grade">${dias}</div>
      <div class="cal-rodape"><button type="button" class="cal-hoje-btn">Hoje</button><button type="button" class="cal-fechar">Fechar</button></div>`;

    // dia que recebe o foco do teclado
    const alvo = cal.querySelector(`.cal-dia[data-iso="${focarDia}"]:not([disabled])`)
      || cal.querySelector('.cal-escolhido:not([disabled])') || cal.querySelector('.cal-hoje:not([disabled])')
      || cal.querySelector('.cal-dia:not([disabled])');
    if (alvo) { alvo.tabIndex = 0; if (focarDia !== undefined) alvo.focus(); }
  }

  function irMes(a, m, focarDia) {
    if (m < 1) { m = 12; a--; } else if (m > 12) { m = 1; a++; }
    const [minA, minM] = minimoCal().split('-').map(Number);
    if (a < minA || (a === minA && m < minM)) { a = minA; m = minM; }
    if (a > ANO_MAX) { a = ANO_MAX; m = 12; }
    calMes = { a, m };
    desenharCal(focarDia);
  }

  function abrirCal() {
    const atual = brParaISO(f.data.value);
    const min = minimoCal();
    const base = atual && atual >= min && atual <= DATA_MAXIMA ? atual : hojeISO();
    const [a, m] = base.split('-').map(Number);
    cal.hidden = false;                      // primeiro aparece, depois recebe o foco
    btnCal.setAttribute('aria-expanded', 'true');
    irMes(a, m, base);
  }
  function fecharCal(voltarFoco) {
    if (cal.hidden) return;
    cal.hidden = true;
    btnCal.setAttribute('aria-expanded', 'false');
    if (voltarFoco) btnCal.focus();
  }
  function escolherDia(iso) {
    f.data.value = isoParaBR(iso);
    f.data.classList.remove('invalido');
    f.data.dispatchEvent(new Event('input', { bubbles: true }));   // mesmo caminho de quando a pessoa digita
    fecharCal(false);
    f.horario.focus();
  }

  btnCal.addEventListener('click', (e) => { e.preventDefault(); cal.hidden ? abrirCal() : fecharCal(false); });
  cal.addEventListener('click', (e) => {
    const dia = e.target.closest('.cal-dia');
    if (dia && !dia.disabled) return escolherDia(dia.dataset.iso);
    const nav = e.target.closest('.cal-nav');
    if (nav && !nav.disabled) return irMes(calMes.a, calMes.m + Number(nav.dataset.nav));
    if (e.target.closest('.cal-hoje-btn')) return escolherDia(hojeISO());
    if (e.target.closest('.cal-fechar')) return fecharCal(true);
  });
  cal.addEventListener('change', (e) => {
    if (e.target.matches('.cal-mes')) irMes(calMes.a, Number(e.target.value));
    if (e.target.matches('.cal-ano')) irMes(Number(e.target.value), calMes.m);
  });
  cal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); return fecharCal(true); }
    const dia = e.target.closest('.cal-dia');
    if (!dia) return;
    const passos = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (!passos) return;
    e.preventDefault();
    const [a, m, d] = dia.dataset.iso.split('-').map(Number);
    const novo = new Date(a, m - 1, d + passos);
    const iso = isoDe(novo.getFullYear(), novo.getMonth() + 1, novo.getDate());
    if (iso < minimoCal() || iso > DATA_MAXIMA) return;
    if (novo.getMonth() + 1 !== m || novo.getFullYear() !== a) irMes(novo.getFullYear(), novo.getMonth() + 1, iso);
    else { dia.tabIndex = -1; const prox = cal.querySelector(`.cal-dia[data-iso="${iso}"]`); prox.tabIndex = 0; prox.focus(); }
  });
  document.addEventListener('mousedown', (e) => {
    if (!cal.hidden && !cal.contains(e.target) && !btnCal.contains(e.target)) fecharCal(false);
  });

  f.data.addEventListener('input', () => {
    if (f.data.value.length === 10) atualizarOcupadosForm();   // só atualiza as sugestões; a agenda muda apenas após salvar
    else desenharSugestoes();
  });
  f.horario.addEventListener('input', desenharSugestoes);
  $('#btn-limpar').addEventListener('click', limparForm);
  $('#btn-cancelar-edicao').addEventListener('click', limparForm);

  /* ---------- Raça: sugestões conforme a espécie ---------- */
  const listaRacas = $('#lista-racas');
  const semAcento = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const racasDa = (especie) => {
    const lista = (window.RACAS && window.RACAS[especie]) || [];
    const [primeira, ...resto] = lista;          // SRD fica sempre no topo
    return primeira ? [primeira, ...resto.slice().sort((x, y) => x.localeCompare(y, 'pt-BR'))] : [];
  };
  let racaAtiva = -1;

  function fecharRacas() {
    listaRacas.hidden = true; listaRacas.innerHTML = ''; racaAtiva = -1;
    f.raca.setAttribute('aria-expanded', 'false');
  }
  function abrirRacas() {
    const especie = radio('f-especie');
    const todas = racasDa(especie);
    if (!todas.length) { fecharRacas(); return; }
    const q = semAcento(f.raca.value.trim());
    // primeiro as que COMEÇAM com o texto; depois as que têm uma palavra começando com ele
    const comeca = todas.filter((r) => semAcento(r).startsWith(q));
    const palavra = q ? todas.filter((r) => !semAcento(r).startsWith(q) && semAcento(r).split(/[\s(\-]+/).some((p) => p.startsWith(q))) : [];
    const itens = comeca.concat(palavra);
    const realce = (r) => {
      if (!q) return esc(r);
      const i = semAcento(r).indexOf(q);
      return i < 0 ? esc(r) : esc(r.slice(0, i)) + '<b>' + esc(r.slice(i, i + q.length)) + '</b>' + esc(r.slice(i + q.length));
    };
    listaRacas.innerHTML = itens.length
      ? itens.map((r, i) => `<li role="option" id="raca-op-${i}" data-raca="${esc(r)}">${realce(r)}</li>`).join('')
      : '<li class="sem-resultado">Nenhuma raça encontrada. Pode digitar o nome mesmo assim.</li>';
    racaAtiva = -1;
    listaRacas.hidden = false;
    f.raca.setAttribute('aria-expanded', 'true');
  }
  function escolherRaca(nome) { f.raca.value = nome; fecharRacas(); }
  function moverRaca(passo) {
    const ops = listaRacas.querySelectorAll('li[data-raca]');
    if (!ops.length) return;
    racaAtiva = (racaAtiva + passo + ops.length) % ops.length;
    ops.forEach((li, i) => li.classList.toggle('ativa', i === racaAtiva));
    ops[racaAtiva].scrollIntoView({ block: 'nearest' });
    f.raca.setAttribute('aria-activedescendant', ops[racaAtiva].id);
  }
  f.raca.addEventListener('focus', abrirRacas);
  f.raca.addEventListener('click', abrirRacas);
  f.raca.addEventListener('input', abrirRacas);
  f.raca.addEventListener('keydown', (e) => {
    if (listaRacas.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); moverRaca(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moverRaca(-1); }
    else if (e.key === 'Enter') {
      const op = listaRacas.querySelectorAll('li[data-raca]')[racaAtiva];
      if (op) { e.preventDefault(); escolherRaca(op.dataset.raca); }
    } else if (e.key === 'Escape') fecharRacas();
  });
  listaRacas.addEventListener('mousedown', (e) => {   // mousedown: antes do input perder o foco
    const li = e.target.closest('li[data-raca]');
    if (li) { e.preventDefault(); escolherRaca(li.dataset.raca); }
  });
  f.raca.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== f.raca) fecharRacas(); }, 120));
  // Nomes com a letra inicial maiúscula: "ana souza" -> "Ana Souza", "THOR" -> "Thor".
  // "da, de, do, das, dos, e" ficam minúsculos no meio do nome (Maria da Silva).
  const LIGACOES = new Set(['da', 'de', 'do', 'das', 'dos', 'e', 'di', 'du', 'del', 'van', 'von']);
  function nomeProprio(txt) {
    const limpo = String(txt || '').replace(/\s+/g, ' ').trim();
    if (!limpo) return '';
    return limpo.split(' ').map((palavra, i) => {
      const tudoMaiusculo = palavra === palavra.toLocaleUpperCase('pt-BR') && /\p{L}{2,}/u.test(palavra);
      let p = tudoMaiusculo ? palavra.toLocaleLowerCase('pt-BR') : palavra;
      if (i > 0 && LIGACOES.has(p.toLocaleLowerCase('pt-BR'))) return p.toLocaleLowerCase('pt-BR');
      // maiúscula no começo e depois de hífen ou apóstrofo (Maria-Clara, D'Ávila)
      return p.replace(/(^|[-'’])(\p{L})/gu, (m, sep, letra) => sep + letra.toLocaleUpperCase('pt-BR'));
    }).join(' ');
  }
  [f.tutor, f.pet].forEach((campo) => campo.addEventListener('blur', () => { campo.value = nomeProprio(campo.value); }));

  // Raça só pode ser usada depois de escolher a espécie (Canino ou Felino)
  function travarRaca() {
    const especie = radio('f-especie');
    f.raca.disabled = !especie;
    f.raca.placeholder = !especie ? 'Escolha a espécie'
      : especie === 'Canino' ? 'Digite a raça do cão' : 'Digite a raça do gato';
    if (!especie) fecharRacas();
  }
  $$('input[name="f-especie"]').forEach((r) => r.addEventListener('change', () => {
    // trocou de espécie: apaga a raça se ela for da outra espécie (ex.: "Shih Tzu" em Felino)
    const atual = radio('f-especie');
    const outra = atual === 'Canino' ? 'Felino' : 'Canino';
    const v = semAcento(f.raca.value.trim());
    if (v && racasDa(outra).some((x) => semAcento(x) === v) && !racasDa(atual).some((x) => semAcento(x) === v)) f.raca.value = '';
    travarRaca();
    if (document.activeElement === f.raca) abrirRacas();
  }));

  const radio = (nome) => (document.querySelector(`input[name="${nome}"]:checked`) || {}).value || null;
  const marcarRadio = (nome, valor) => $$(`input[name="${nome}"]`).forEach((r) => { r.checked = r.value === valor; });

  function limparForm() {
    $('#form-agendamento').reset();
    f.id.value = '';
    soltarCliente();
    fecharClientes();
    estado.dataOriginal = null;
    const dia = estado.diaAgenda || hojeISO();
    f.data.value = isoParaBR(dia < hojeISO() ? hojeISO() : dia);
    $('#form-titulo').textContent = 'Novo agendamento';
    $('#btn-salvar').textContent = 'Salvar agendamento';
    $('#btn-cancelar-edicao').hidden = true;
    $('#form-erro').textContent = '';
    $$('#form-agendamento .invalido').forEach((el) => el.classList.remove('invalido'));
    $('.opcionais').open = false;
    fecharRacas();
    travarRaca();
    fecharCal(false);
    cepBusca.limpar();
    cepEntrega.limpar();
    mostrarServicoOutro();
    mostrarEndereco();
    atualizarOcupadosForm();
  }

  function preencherForm(a) {
    limparForm();
    f.id.value = a.id;
    estado.dataOriginal = a.data;
    f.data.value = isoParaBR(a.data);
    f.horario.value = hhmm(a.horario);
    f.tutor.value = a.tutor_nome || '';
    f.telefone.value = formatarTelefone(a.telefone || '');
    f.pet.value = a.pet_nome || '';
    fPetId.value = a.pet_id || '';
    lerIdade(a.pet_idade);
    f.saude.value = a.saude_obs || '';
    f.peso.value = a.peso_kg ? String(a.peso_kg).replace('.', ',') : '';
    f.raca.value = a.raca || '';
    f.obs.value = a.observacoes || '';
    f.busca.checked = !!a.busca_domicilio;
    f.entrega.checked = !!a.entrega_domicilio;
    f.cep.value = a.end_cep ? a.end_cep.replace(/^(\d{5})(\d{3})$/, '$1-$2') : '';
    f.rua.value = a.end_rua || '';
    f.numero.value = a.end_numero || '';
    f.bairro.value = a.end_bairro || '';
    f.cidade.value = a.end_cidade || '';
    f.referencia.value = a.end_referencia || '';
    f.outroEnd.checked = !!a.entrega_outro_end;
    f.entCep.value = a.ent_cep ? a.ent_cep.replace(/^(\d{5})(\d{3})$/, '$1-$2') : '';
    f.entRua.value = a.ent_rua || '';
    f.entNumero.value = a.ent_numero || '';
    f.entBairro.value = a.ent_bairro || '';
    f.entCidade.value = a.ent_cidade || '';
    f.entReferencia.value = a.ent_referencia || '';
    cepBusca.carregado();
    cepEntrega.carregado();
    if (a.servico) {
      const padrao = SERVICOS.includes(a.servico) && a.servico !== 'Outro';
      marcarRadio('f-servico', padrao ? a.servico : 'Outro');
      f.servicoOutro.value = padrao ? '' : a.servico;
    }
    f.valor.value = a.servico_valor != null ? String(Number(a.servico_valor).toFixed(2)).replace('.', ',') : '';
    mostrarServicoOutro();
    mostrarEndereco();
    marcarRadio('f-especie', a.especie);
    travarRaca();
    marcarRadio('f-sexo', a.pet_sexo);
    marcarRadio('f-porte', a.porte);
    marcarRadio('f-pelagem', a.pelagem);
    if (a.porte || a.peso_kg || a.raca || a.pelagem || a.observacoes) $('.opcionais').open = true;
    $('#form-titulo').textContent = `Editando: ${a.pet_nome}`;
    $('#btn-salvar').textContent = 'Salvar alterações';
    $('#btn-cancelar-edicao').hidden = false;
    atualizarOcupadosForm();
    f.horario.focus();
  }

  // ---------------------------------------------------------------
  // Cliente cadastrado: busca por celular, tutor ou pet e preenche o formulário.
  // A loja só escolhe data, horário, serviço e valor.
  // ---------------------------------------------------------------
  const clienteInput = $('#f-cliente'), clienteLista = $('#cliente-lista'), fichaPet = $('#ficha-pet'), fPetId = $('#f-pet-id');
  let clienteSeq = 0, clienteTimer = null, clienteResultados = [], clienteAtivo = -1;
  estado.cliente = null;
  const normNome = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  // data de nascimento -> idade para o formulário (meses até 1 ano)
  function idadeDe(nasc) {
    if (!nasc) return null;
    const [a, m, d] = nasc.split('-').map(Number);
    const [ha, hm, hd] = hojeISO().split('-').map(Number);
    let meses = (ha - a) * 12 + (hm - m) - (hd < d ? 1 : 0);
    if (meses < 0) meses = 0;
    return meses < 12 ? { n: meses, un: 'meses' } : { n: Math.floor(meses / 12), un: 'anos' };
  }
  const textoIdadeDe = (nasc) => { const i = idadeDe(nasc); return !i ? '' : i.un === 'meses' ? (i.n === 1 ? '1 mês' : `${i.n} meses`) : (i.n === 1 ? '1 ano' : `${i.n} anos`); };
  const precisaConferir = (r) => r && (r.tutor_conferido === false || r.pet_conferido === false);

  function fecharClientes() { clienteLista.hidden = true; clienteInput.setAttribute('aria-expanded', 'false'); clienteAtivo = -1; }
  function desenharClientes(msg) {
    clienteLista.innerHTML = msg ? `<li class="cl-vazio">${msg}</li>`
      : clienteResultados.map((r, i) => `<li role="option" id="cl-${i}" data-i="${i}" class="cl-item${i === clienteAtivo ? ' ativo' : ''}" aria-selected="${i === clienteAtivo}">
          <span class="cl-pet">${r.pet_id ? `🐾 <b>${esc(r.pet_nome)}</b>${r.especie ? ` · ${esc(r.especie)}` : ''}${r.raca ? ` · ${esc(r.raca)}` : ''}` : '<i>sem pet cadastrado</i>'}
            ${precisaConferir(r) ? '<span class="tag tag-novo">🆕 conferir</span>' : ''}${r.tem_saude ? '<span class="tag tag-saude">⚠️ saúde</span>' : ''}</span>
          <span class="cl-tutor">${esc(r.tutor_nome)} · <span class="sem-quebra">${esc(formatarTelefone(r.telefone))}</span></span>
        </li>`).join('');
    clienteLista.hidden = false;
    clienteInput.setAttribute('aria-expanded', 'true');
  }
  async function buscarClientes(q) {
    const seq = ++clienteSeq;
    const { data, error } = await sb.rpc('buscar_clientes', { q });
    if (seq !== clienteSeq || clienteInput.value.trim() !== q) return;
    if (error) {
      clienteResultados = [];
      return desenharClientes(error.code === 'PGRST202' || /buscar_clientes/.test(error.message || '')
        ? 'O cadastro de clientes ainda não foi ativado no banco (rode a atualização v5 no Supabase).'
        : 'Não foi possível buscar agora. Verifique a conexão.');
    }
    clienteResultados = data || [];
    clienteAtivo = clienteResultados.length ? 0 : -1;
    desenharClientes(clienteResultados.length ? '' : 'Nenhum cliente encontrado. Preencha abaixo: o cadastro é criado sozinho ao salvar (com o celular).');
  }
  clienteInput.addEventListener('input', () => {
    clearTimeout(clienteTimer);
    const q = clienteInput.value.trim();
    if (q.replace(/\D/g, '').length < 4 && q.length < 2) { clienteSeq++; return fecharClientes(); }
    clienteTimer = setTimeout(() => buscarClientes(q), 250);
  });
  clienteInput.addEventListener('keydown', (e) => {
    if (clienteLista.hidden || !clienteResultados.length) { if (e.key === 'Enter') e.preventDefault(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      clienteAtivo = (clienteAtivo + (e.key === 'ArrowDown' ? 1 : -1) + clienteResultados.length) % clienteResultados.length;
      desenharClientes();
      clienteInput.setAttribute('aria-activedescendant', `cl-${clienteAtivo}`);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (clienteAtivo >= 0) escolherCliente(clienteResultados[clienteAtivo]);
    } else if (e.key === 'Escape') fecharClientes();
  });
  clienteLista.addEventListener('mousedown', (e) => e.preventDefault());   // não perde o foco antes do clique
  clienteLista.addEventListener('click', (e) => {
    const li = e.target.closest('[data-i]');
    if (li) escolherCliente(clienteResultados[Number(li.dataset.i)]);
  });
  clienteInput.addEventListener('blur', () => setTimeout(fecharClientes, 150));

  function preencherEnderecoCliente() {
    const c = estado.cliente;
    if (!c || !c.end_rua || f.rua.value.trim() || !temTransporte()) return;
    f.cep.value = c.end_cep ? c.end_cep.replace(/^(\d{5})(\d{3})$/, '$1-$2') : '';
    f.rua.value = c.end_rua || ''; f.numero.value = c.end_numero || '';
    f.bairro.value = c.end_bairro || ''; f.cidade.value = c.end_cidade || ''; f.referencia.value = c.end_referencia || '';
    cepBusca.carregado();
  }
  [f.busca, f.entrega].forEach((c) => c.addEventListener('change', preencherEnderecoCliente));

  function escolherCliente(r) {
    if (!r) return;
    estado.cliente = r;
    fecharClientes();
    clienteInput.value = '';
    f.tutor.value = r.tutor_nome || '';
    f.telefone.value = formatarTelefone(r.telefone || '');
    if (r.pet_id) {
      fPetId.value = r.pet_id;
      f.pet.value = r.pet_nome || '';
      marcarRadio('f-especie', r.especie);
      travarRaca();
      marcarRadio('f-sexo', r.sexo);
      const i = idadeDe(r.nascimento);
      f.idade.value = i ? String(i.n) : '';
      fIdadeUn.value = i ? i.un : 'anos';
      f.saude.value = r.tem_saude ? (r.saude_obs || '') : '';
      marcarRadio('f-porte', r.porte);
      f.peso.value = r.peso_kg ? String(Number(r.peso_kg)).replace('.', ',') : '';
      f.raca.value = r.raca || '';
      marcarRadio('f-pelagem', r.pelagem);
      f.obs.value = r.observacoes || '';
      if (r.porte || r.peso_kg || r.raca || r.pelagem || r.observacoes) $('.opcionais').open = true;
    } else {
      fPetId.value = '';
    }
    $$('#form-agendamento .invalido').forEach((el) => el.classList.remove('invalido'));
    preencherEnderecoCliente();
    desenharFicha();
    if (r.pet_id) carregarHistoricoPet(r.pet_id);
    (r.pet_id ? (f.horario.value ? f.data : f.horario) : f.pet).focus();
  }

  function desenharFicha(historico, agendados) {
    const r = estado.cliente;
    if (!r) { fichaPet.hidden = true; fichaPet.innerHTML = ''; return; }
    const idade = textoIdadeDe(r.nascimento);
    const ultimo = historico && historico[0];
    const ultimoTxt = ultimo && ultimo.servico
      ? `${esc(ultimo.servico)}${ultimo.servico_valor != null ? ' · R$ ' + Number(ultimo.servico_valor).toFixed(2).replace('.', ',') : ''}` : '';
    fichaPet.innerHTML = `
      <div class="ficha-cab">
        <span>${r.pet_id ? `🐾 <b>${esc(r.pet_nome)}</b>${r.especie ? ' · ' + esc(r.especie) : ''}${idade ? ' · ' + idade : ''}` : `👤 <b>${esc(r.tutor_nome)}</b>`}
          <small>tutor ${esc(r.tutor_nome)}</small></span>
        <button type="button" class="link-btn" id="ficha-trocar">Trocar cliente</button>
      </div>
      ${estado.perfil && estado.perfil.papel === 'admin' ? '<button type="button" class="link-btn ficha-senha" id="ficha-senha">🔑 Senha do tutor</button>' : ''}
      ${precisaConferir(r) ? `<div class="ficha-novo"><span>🆕 <b>Cadastro feito ou alterado pelo tutor.</b> Confira os dados com ele.</span>
        <button type="button" class="btn btn-pequeno btn-ok" id="ficha-conferir">✓ Dados conferidos</button></div>` : ''}
      ${r.tem_saude ? `<div class="ficha-saude">⚠️ <b>Saúde:</b> ${esc(r.saude_obs || 'tem alergia ou problema de saúde (sem detalhes)')}</div>` : ''}
      ${r.observacoes ? `<div class="ficha-obs">📝 ${esc(r.observacoes)}</div>` : ''}
      ${r.pet_id && agendados && agendados.length ? `<div class="ficha-hist ficha-agendados"><span class="ficha-hist-tit">Agendados</span><ul>${agendados.map((h) => {
          const quando = h.data === hojeISO() ? 'hoje' : h.data === somarDias(hojeISO(), 1) ? 'amanhã' : '';
          return `<li><span class="sem-quebra">${isoParaBR(h.data)}</span> às ${hhmm(h.horario)}${quando ? ` <span class="tag tag-quando">${quando}</span>` : ''} · ${esc(h.servico || 'sem serviço informado')}${h.servico_valor != null ? ` · <b class="sem-quebra">R$ ${Number(h.servico_valor).toFixed(2).replace('.', ',')}</b>` : ''}${h.status === 'em_banho' ? ' <span class="tag tag-em_banho">Em banho</span>' : ''}</li>`;
        }).join('')}</ul></div>` : ''}
      ${r.pet_id ? `<div class="ficha-hist">${historico === undefined ? '<span class="nota">Carregando últimos atendimentos…</span>'
        : !historico.length ? `<span class="nota">${agendados && agendados.length ? 'Nenhum atendimento finalizado ainda.' : 'Primeiro atendimento deste pet.'}</span>`
        : `<span class="ficha-hist-tit">Últimos atendimentos</span><ul>${historico.map((h) => `<li><span class="sem-quebra">${isoParaBR(h.data)}</span> · ${esc(h.servico || 'sem serviço informado')}${h.servico_valor != null ? ` · <b class="sem-quebra">R$ ${Number(h.servico_valor).toFixed(2).replace('.', ',')}</b>` : ''}</li>`).join('')}</ul>
           ${ultimo ? `<button type="button" class="btn btn-pequeno btn-repetir" id="ficha-repetir">↻ Repetir último${ultimoTxt ? `: ${ultimoTxt}` : ''}</button>` : ''}`}</div>` : ''}`;
    fichaPet.hidden = false;
    estado.ultimoAtendimento = ultimo || null;
  }
  // Agendados = ainda vão acontecer (agendado / em banho). Últimos atendimentos = só os finalizados ou entregues.
  async function carregarHistoricoPet(petId) {
    const campos = 'data, horario, servico, servico_valor, status, busca_domicilio, entrega_domicilio, entrega_outro_end, end_cep, end_rua, end_numero, end_bairro, end_cidade, end_referencia, ent_cep, ent_rua, ent_numero, ent_bairro, ent_cidade, ent_referencia';
    const [feitos, futuros] = await Promise.all([
      sb.from('agendamentos').select(campos).eq('pet_id', petId).in('status', ['finalizado', 'entregue'])
        .order('data', { ascending: false }).order('horario', { ascending: false }).limit(3),
      sb.from('agendamentos').select('data, horario, servico, servico_valor, status').eq('pet_id', petId).in('status', ['agendado', 'em_banho'])
        .order('data', { ascending: true }).order('horario', { ascending: true }).limit(5)
    ]);
    if (!estado.cliente || estado.cliente.pet_id !== petId) return;
    desenharFicha(feitos.error ? [] : (feitos.data || []), futuros.error ? [] : (futuros.data || []));
  }
  // "Repetir último": mesmo serviço, valor e leva e traz do último atendimento
  function repetirUltimo() {
    const u = estado.ultimoAtendimento;
    if (!u) return;
    if (u.servico) {
      const padrao = SERVICOS.includes(u.servico) && u.servico !== 'Outro';
      marcarRadio('f-servico', padrao ? u.servico : 'Outro');
      f.servicoOutro.value = padrao ? '' : u.servico;
    }
    f.valor.value = u.servico_valor != null ? Number(u.servico_valor).toFixed(2).replace('.', ',') : '';
    mostrarServicoOutro();
    f.busca.checked = !!u.busca_domicilio;
    f.entrega.checked = !!u.entrega_domicilio;
    f.outroEnd.checked = !!u.entrega_outro_end;
    if (u.end_rua) {
      f.cep.value = u.end_cep ? u.end_cep.replace(/^(\d{5})(\d{3})$/, '$1-$2') : '';
      f.rua.value = u.end_rua; f.numero.value = u.end_numero || ''; f.bairro.value = u.end_bairro || '';
      f.cidade.value = u.end_cidade || ''; f.referencia.value = u.end_referencia || '';
      cepBusca.carregado();
    }
    if (u.ent_rua) {
      f.entCep.value = u.ent_cep ? u.ent_cep.replace(/^(\d{5})(\d{3})$/, '$1-$2') : '';
      f.entRua.value = u.ent_rua; f.entNumero.value = u.ent_numero || ''; f.entBairro.value = u.ent_bairro || '';
      f.entCidade.value = u.ent_cidade || ''; f.entReferencia.value = u.ent_referencia || '';
      cepEntrega.carregado();
    }
    mostrarEndereco();
    preencherEnderecoCliente();
    toast('Serviço, valor e leva e traz do último atendimento preenchidos. Agora escolha data e horário.', 'ok');
    (f.data.value ? f.horario : f.data).focus();
  }
  async function marcarConferido() {
    const r = estado.cliente;
    if (!r) return;
    const [t, p] = await Promise.all([
      sb.from('tutores').update({ conferido: true }).eq('id', r.tutor_id),
      sb.from('pets').update({ conferido: true }).eq('tutor_id', r.tutor_id)
    ]);
    if (t.error || p.error) return toast('Não foi possível marcar como conferido.', 'erro');
    r.tutor_conferido = true; r.pet_conferido = true;
    toast('Cadastro conferido.', 'ok');
    if (r.pet_id) carregarHistoricoPet(r.pet_id); else desenharFicha();
  }
  function soltarCliente() {
    estado.cliente = null;
    estado.ultimoAtendimento = null;
    fPetId.value = '';
    desenharFicha();
  }
  fichaPet.addEventListener('click', (e) => {
    if (e.target.closest('#ficha-trocar')) { soltarCliente(); clienteInput.focus(); return; }
    if (e.target.closest('#ficha-conferir')) return marcarConferido();
    if (e.target.closest('#ficha-repetir')) return repetirUltimo();
  });
  // o pet escolhido só vale se o nome e o celular continuarem os mesmos
  function petIdValido() {
    const c = estado.cliente;
    if (!fPetId.value) return null;
    if (c && (normNome(f.pet.value) !== normNome(c.pet_nome) || soDigitos(f.telefone.value) !== soDigitos(c.telefone))) return null;
    return fPetId.value;
  }

  // horários já ocupados na data do formulário (para as sugestões)
  async function atualizarOcupadosForm() {
    const iso = brParaISO(f.data.value);
    if (!iso) { estado.ocupadosForm = []; desenharSugestoes(); return; }
    const { data } = await sb.from('agendamentos').select('id, horario').eq('data', iso).neq('status', 'cancelado');
    if (brParaISO(f.data.value) !== iso) return;
    estado.ocupadosForm = (data || []).filter((x) => x.id !== f.id.value).map((x) => hhmm(x.horario));
    desenharSugestoes();
  }

  function gradeHorarios() {
    const [hi, mi] = (C.HORARIO_INICIO || '07:00').split(':').map(Number);
    const [hf, mf] = (C.HORARIO_FIM || '19:00').split(':').map(Number);
    const passo = Math.max(5, C.INTERVALO_MIN || 30);
    const out = [];
    for (let t = hi * 60 + mi; t <= hf * 60 + mf; t += passo) out.push(`${pad(Math.floor(t / 60))}:${pad(t % 60)}`);
    return out;
  }

  function desenharSugestoes() {
    const box = $('#sugestoes');
    const isoForm = brParaISO(f.data.value);
    if (!isoForm) {
      box.innerHTML = f.data.value.length === 10
        ? '<span class="aviso-ocupado">Data inexistente. Confira o dia e o mês (ex.: abril tem 30 dias; 29/02 só existe em ano bissexto).</span>' : '';
      return;
    }
    if (dataAlemDoLimite(isoForm)) {
      box.innerHTML = '<span class="aviso-ocupado">A data máxima para agendamento é 31/12/2100.</span>';
      return;
    }
    if (dataPassada(isoForm)) {
      box.innerHTML = '<span class="aviso-ocupado">Esta data já passou. Só é possível agendar a partir de hoje (' + isoParaBR(hojeISO()) + ').</span>';
      return;
    }
    const ocup = new Set(estado.ocupadosForm);
    const atual = f.horario.value;
    const aviso = horaValida(atual) && ocup.has(atual)
      ? `<span class="aviso-ocupado">${esc(atual)} já está ocupado nesta data.</span>` : '';
    box.innerHTML = '<span class="rotulo">Horários (riscados = ocupados):</span>' +
      gradeHorarios().map((h) => ocup.has(h)
        ? `<button type="button" class="hora ocupada" disabled title="Ocupado">${h}</button>`
        : `<button type="button" class="hora" data-hora="${h}">${h}</button>`).join('') + aviso;
  }
  $('#sugestoes').addEventListener('click', (e) => {
    const b = e.target.closest('.hora[data-hora]');
    if (!b) return;
    f.horario.value = b.dataset.hora;
    f.horario.classList.remove('invalido');
    desenharSugestoes();
  });

  function validar() {
    const erros = [];
    const marca = (el, ok) => { el.classList.toggle('invalido', !ok); return ok; };
    const dataISO = brParaISO(f.data.value);
    if (!marca(f.data, !!dataISO)) erros.push('Data inválida (use DD/MM/AAAA).');
    else if (dataAlemDoLimite(dataISO)) {
      marca(f.data, false);
      erros.push('A data máxima para agendamento é 31/12/2100.');
    } else if (dataPassada(dataISO)) {
      marca(f.data, false);
      erros.push('Não é possível agendar em uma data que já passou. Escolha hoje ou uma data futura.');
    }
    if (!marca(f.horario, horaValida(f.horario.value))) erros.push('Horário inválido (use HH:MM).');
    const idadeN = parseInt(f.idade.value, 10);
    if (!marca(f.idade, !idadeN || (fIdadeUn.value === 'meses' ? idadeN <= 420 : idadeN <= 35))) erros.push('Idade inválida: um pet não passa de 35 anos.');
    if (!marca(f.tutor, f.tutor.value.trim().length > 0)) erros.push('Informe o nome do tutor.');
    if (!marca(f.pet, f.pet.value.trim().length > 0)) erros.push('Informe o nome do animal.');
    const tel = soDigitos(f.telefone.value);
    if (!marca(f.telefone, !tel || tel.length >= 10)) erros.push('Telefone incompleto.');
    if (temTransporte()) {
      const cep = soDigitos(f.cep.value);
      if (!marca(f.cep, !cep || cep.length === 8)) erros.push('CEP incompleto.');
      if (!marca(f.rua, f.rua.value.trim().length > 0)) erros.push('Informe a rua para a busca/entrega.');
      if (!marca(f.numero, f.numero.value.trim().length > 0)) erros.push('Informe o número da casa para a busca/entrega.');
    }
    if (servicoMarcado() === 'Outro' && !marca(f.servicoOutro, f.servicoOutro.value.trim().length > 0)) erros.push('Escreva qual é o serviço.');
    const valor = lerValor();
    if (!marca(f.valor, valor === null || (valor >= 0 && valor <= 99999))) erros.push('Valor inválido (use, por exemplo, 85,50).');
    if (temOutroEnd()) {
      const cep = soDigitos(f.entCep.value);
      if (!marca(f.entCep, !cep || cep.length === 8)) erros.push('CEP de entrega incompleto.');
      if (!marca(f.entRua, f.entRua.value.trim().length > 0)) erros.push('Informe a rua do endereço de entrega.');
      if (!marca(f.entNumero, f.entNumero.value.trim().length > 0)) erros.push('Informe o número do endereço de entrega.');
    }
    const peso = f.peso.value ? Number(f.peso.value.replace(',', '.')) : null;
    if (!marca(f.peso, peso === null || (peso > 0 && peso < 999))) erros.push('Peso inválido.');
    return { erros, peso };
  }

  $('#form-agendamento').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { erros, peso } = validar();
    $('#form-erro').textContent = erros.join(' ');
    if (erros.length) return;

    const registro = {
      data: brParaISO(f.data.value),
      horario: f.horario.value,
      tutor_nome: nomeProprio(f.tutor.value),
      telefone: soDigitos(f.telefone.value) || null,
      pet_nome: nomeProprio(f.pet.value),
      pet_idade: textoIdade(),
      especie: radio('f-especie'),
      pet_sexo: radio('f-sexo'),
      saude_obs: f.saude.value.trim() || null,
      porte: radio('f-porte'),
      peso_kg: peso,
      raca: f.raca.value.trim() || null,
      pelagem: radio('f-pelagem'),
      observacoes: f.obs.value.trim() || null,
      // leva e traz (sem busca/entrega, o endereço não é guardado)
      busca_domicilio: f.busca.checked,
      entrega_domicilio: f.entrega.checked,
      end_cep: temTransporte() ? (soDigitos(f.cep.value) || null) : null,
      end_rua: temTransporte() ? (nomeProprio(f.rua.value) || null) : null,
      end_numero: temTransporte() ? (f.numero.value.trim() || null) : null,
      end_bairro: temTransporte() ? (nomeProprio(f.bairro.value) || null) : null,
      end_cidade: temTransporte() ? (f.cidade.value.trim() || null) : null,
      end_referencia: temTransporte() ? (f.referencia.value.trim() || null) : null,
      // entrega em outro endereço
      entrega_outro_end: temOutroEnd(),
      ent_cep: temOutroEnd() ? (soDigitos(f.entCep.value) || null) : null,
      ent_rua: temOutroEnd() ? (nomeProprio(f.entRua.value) || null) : null,
      ent_numero: temOutroEnd() ? (f.entNumero.value.trim() || null) : null,
      ent_bairro: temOutroEnd() ? (nomeProprio(f.entBairro.value) || null) : null,
      ent_cidade: temOutroEnd() ? (f.entCidade.value.trim() || null) : null,
      ent_referencia: temOutroEnd() ? (f.entReferencia.value.trim() || null) : null,
      // serviço e valor (opcionais)
      servico: servicoEscolhido(),
      servico_valor: servicoEscolhido() ? lerValor() : null
    };
    // ligação com o cadastro do pet (só se o banco já tiver o cadastro de clientes)
    if (estado.temClientes !== false) registro.pet_id = petIdValido();

    const btn = $('#btn-salvar');
    btn.disabled = true;
    const editando = !!f.id.value;
    const gravar = () => (editando
      ? sb.from('agendamentos').update(registro).eq('id', f.id.value)
      : sb.from('agendamentos').insert(registro));
    let { error } = await gravar();
    // banco ainda sem o cadastro de clientes (atualização v5 não rodada): salva sem a ligação com o pet
    if (error && 'pet_id' in registro && /pet_id/.test(`${error.message || ''} ${error.details || ''}`)) {
      estado.temClientes = false;
      delete registro.pet_id;
      ({ error } = await gravar());
    }
    btn.disabled = false;

    if (error) {
      // 23505 = o banco recusou porque outro animal já ocupa a data/horário
      if (error.code === '23505') return conflito(registro.data, registro.horario);
      if ((error.message || '').includes('data que já passou')) {
        f.data.classList.add('invalido');
        $('#form-erro').textContent = 'Não é possível agendar em uma data que já passou. Escolha hoje ou uma data futura.';
        return;
      }
      if ((error.message || '').includes('31/12/2100')) {
        f.data.classList.add('invalido');
        $('#form-erro').textContent = 'A data máxima para agendamento é 31/12/2100.';
        return;
      }
      if (/Idade inválida/.test(error.message || '')) {
        f.idade.classList.add('invalido');
        $('#form-erro').textContent = 'Idade inválida: um pet não passa de 35 anos.';
        return;
      }
      if (error.code === '23514') {
        $('#form-erro').textContent = 'Algum campo passou do limite (nomes até 120 letras, textos até 500, telefone só números, CEP com 8 dígitos). Confira e tente de novo.';
        return;
      }
      $('#form-erro').textContent = 'Não foi possível salvar. Verifique a conexão e tente novamente.';
      return;
    }
    toast(editando ? 'Agendamento atualizado.' : `${registro.pet_nome} agendado para ${isoParaBR(registro.data)} às ${registro.horario}.`, 'ok');
    const dia = registro.data;
    limparForm();
    irParaDia(dia);
  });

  // Conflito: mensagem + recarrega a lista mostrando o animal que o outro usuário cadastrou
  async function conflito(dataISO, hora) {
    estado.destacar = hora;
    estado.filtro = 'ativos';
    $$('[data-filtro]').forEach((x) => x.classList.toggle('ativo', x.dataset.filtro === 'ativos'));
    irParaDia(dataISO);
    atualizarOcupadosForm();
    f.horario.classList.add('invalido');
    await janela({ titulo: 'Horário indisponível', texto: MSG_CONFLITO, erro: true });
    f.horario.focus();
  }

  /* =================================================================
     Gráficos de entradas (somente leitura)
     ================================================================= */
  const gMes = $('#g-mes'), gAno = $('#g-ano');
  (function montarSeletores() {
    const hoje = new Date();
    gMes.innerHTML = MESES.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('');
    gMes.value = String(hoje.getMonth() + 1);
    const anos = [];
    for (let a = hoje.getFullYear() + 1; a >= hoje.getFullYear() - 5; a--) anos.push(a);
    gAno.innerHTML = anos.map((a) => `<option value="${a}">${a}</option>`).join('');
    gAno.value = String(hoje.getFullYear());
  })();
  gMes.addEventListener('change', carregarGraficos);
  gAno.addEventListener('change', carregarGraficos);
  $$('[data-agrupar]').forEach((b) => b.addEventListener('click', () => {
    estado.agrupar = b.dataset.agrupar;
    $$('[data-agrupar]').forEach((x) => x.classList.toggle('ativo', x === b));
    carregarGraficos();
  }));

  // Biblioteca dos gráficos só é baixada na primeira vez que a aba Gráficos é aberta
  let chartPronto = null;
  function carregarChartJs() {
    if (window.Chart) return Promise.resolve();
    if (!chartPronto) {
      chartPronto = new Promise((ok, falha) => {
        const sc = document.createElement('script');
        sc.src = 'vendor/chart.umd.js';                       // biblioteca guardada no próprio projeto (pasta vendor)
        sc.onload = ok;
        sc.onerror = () => { chartPronto = null; falha(new Error('chart.js')); };
        document.head.appendChild(sc);
      });
    }
    return chartPronto;
  }

  async function carregarGraficos() {
    try { await carregarChartJs(); } catch (e) { toast('Não foi possível carregar os gráficos. Verifique a internet.', 'erro'); return; }
    const g = estado.agrupar;
    $('#ctl-mes').hidden = g !== 'dia';
    $('#ctl-ano').hidden = g === 'ano';
    const ano = Number(gAno.value), mes = Number(gMes.value);

    let inicio, fim, rotulos, chave;
    if (g === 'dia') {
      const dias = new Date(ano, mes, 0).getDate();
      inicio = `${ano}-${pad(mes)}-01`; fim = `${ano}-${pad(mes)}-${pad(dias)}`;
      rotulos = Array.from({ length: dias }, (_, i) => pad(i + 1));
      chave = (d) => d.slice(8, 10);
    } else if (g === 'mes') {
      inicio = `${ano}-01-01`; fim = `${ano}-12-31`;
      rotulos = MESES.map((m) => m.slice(0, 3));
      chave = (d) => MESES[Number(d.slice(5, 7)) - 1].slice(0, 3);
    } else {
      inicio = '2000-01-01'; fim = '2100-12-31';
      rotulos = null; chave = (d) => d.slice(0, 4);
    }

    // Contagem feita no próprio banco (rápido mesmo com anos de dados).
    // Se a função ainda não existir no Supabase, usa o jeito antigo (baixa os registros e conta aqui).
    let agg = null;
    const { data: rpc, error: erroRpc } = await sb.rpc('contagem_entradas', { p_inicio: inicio, p_fim: fim, p_agrupar: g });
    if (!erroRpc && Array.isArray(rpc)) {
      agg = rpc.map((r) => ({ k: g === 'mes' ? MESES[Number(r.chave) - 1].slice(0, 3) : String(r.chave), origem: r.origem, reg: Number(r.registrados), fin: Number(r.finalizados) }));
    } else {
      let linhas = [], de = 0;
      for (;;) {
        const { data, error } = await sb.from('agendamentos').select('data, status, origem')
          .gte('data', inicio).lte('data', fim).neq('status', 'cancelado').order('data').range(de, de + 999);
        if (error) { toast('Não foi possível carregar os gráficos.', 'erro'); return; }
        linhas = linhas.concat(data || []);
        if (!data || data.length < 1000) break;
        de += 1000;
      }
      const mapa = new Map();
      linhas.forEach((l) => {
        const k = chave(l.data), id = k + '|' + l.origem;
        const a = mapa.get(id) || { k, origem: l.origem, reg: 0, fin: 0 };
        a.reg++;
        if (l.status === 'finalizado' || l.status === 'entregue') a.fin++;   // entregue = banho finalizado e retirado
        mapa.set(id, a);
      });
      agg = [...mapa.values()];
    }

    if (!rotulos) {
      const anos = [...new Set(agg.map((a) => a.k))].sort();
      rotulos = anos.length ? anos : [String(new Date().getFullYear())];
    }

    const origens = ['petshop', 'banho_tosa'];
    if (agg.some((a) => a.origem === 'admin')) origens.push('admin');
    if (agg.some((a) => a.origem === 'teste')) origens.push('teste');      // usuário de testes: coluna separada
    const zero = () => Object.fromEntries(rotulos.map((r) => [r, 0]));
    const cont = {};
    origens.forEach((o) => { cont[o] = { reg: zero(), fin: zero() }; });
    agg.forEach((a) => {
      if (!(a.origem in cont) || !(a.k in cont[a.origem].reg)) return;
      cont[a.origem].reg[a.k] += a.reg;
      cont[a.origem].fin[a.k] += a.fin;
    });

    const cores = {
      petshop: ['#F3B37A', '#B85A0C'],
      banho_tosa: ['#93B2EE', '#2457C5'],
      admin: ['#BDB3E6', '#5B4BA8'],
      teste: ['#B7C1CE', '#55657A']
    };
    // Uma coluna por empresa: altura = registrados; parte escura = finalizados,
    // parte clara = registrados ainda não finalizados.
    const datasets = [];
    origens.forEach((o) => {
      datasets.push({ label: `${NOMES_PAPEL[o]} – finalizados`, data: rotulos.map((r) => cont[o].fin[r]),
        backgroundColor: cores[o][1], stack: o, origem: o });
      datasets.push({ label: `${NOMES_PAPEL[o]} – registrados (não finalizados)`, data: rotulos.map((r) => cont[o].reg[r] - cont[o].fin[r]),
        backgroundColor: cores[o][0], stack: o, origem: o });
    });

    const titulo = g === 'dia' ? `${MESES[mes - 1]} de ${ano}` : g === 'mes' ? `Ano de ${ano}` : 'Todos os anos';
    const celular = window.matchMedia('(max-width: 640px)').matches;
    // legenda própria e compacta (uma linha por empresa, em vez de 6 itens)
    $('#graf-legenda').innerHTML = origens.map((o) =>
      `<span class="leg-item"><span class="leg-cor" style="--escuro:${cores[o][1]};--claro:${cores[o][0]}"></span>${NOMES_PAPEL[o]}</span>`).join('')
      + '<span class="leg-dica">Parte escura = finalizados · parte clara = ainda não finalizados</span>';
    if (estado.grafico) estado.grafico.destroy();
    estado.grafico = new window.Chart($('#grafico'), {
      type: 'bar',
      data: { labels: rotulos, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: celular ? { left: 0, right: 4 } : 8 },
        plugins: {
          title: { display: true, text: titulo, font: { size: celular ? 14 : 15, weight: '700' } },
          legend: { display: false },
          tooltip: {
            mode: 'index', intersect: false,
            callbacks: {
              footer: (itens) => {
                const i = itens[0]?.dataIndex;
                if (i === undefined) return '';
                return origens.map((o) => `${NOMES_PAPEL[o]}: ${cont[o].reg[rotulos[i]]} registrados, ${cont[o].fin[rotulos[i]]} finalizados`).join('\n');
              }
            }
          }
        },
        scales: {
          y: { stacked: true, beginAtZero: true, ticks: { precision: 0, font: { size: celular ? 13 : 12 } }, title: { display: !celular, text: 'Animais' } },
          x: { stacked: true, grid: { display: false },
               ticks: (celular && g === 'dia')
                 // celular: números maiores e só alguns dias (1, 5, 10, 15, 20, 25, 30) para não embolar
                 ? { maxRotation: 0, minRotation: 0, autoSkip: false, font: { size: 13, weight: '600' },
                     callback(valor, i) { const d = i + 1; return (d === 1 || d % 5 === 0) ? this.getLabelForValue(valor) : ''; } }
                 : { maxRotation: 0, minRotation: 0, autoSkip: true, autoSkipPadding: celular ? 10 : 4, font: { size: celular ? 13 : 12, weight: celular ? '600' : 'normal' } } }
        }
      }
    });

    // cartões de totais
    const total = (o, t) => Object.values(cont[o][t]).reduce((s, n) => s + n, 0);
    $('#graf-cartoes').innerHTML = ['petshop', 'banho_tosa'].map((o) => `
      <div class="cartao ${o === 'petshop' ? 'petshop' : 'banho'}"><span>${NOMES_PAPEL[o]} – registrados</span><b>${total(o, 'reg')}</b></div>
      <div class="cartao ${o === 'petshop' ? 'petshop' : 'banho'}"><span>${NOMES_PAPEL[o]} – finalizados</span><b>${total(o, 'fin')}</b></div>`).join('');

    // tabela (desenhada à parte para o "mostrar dias sem movimento" não precisar buscar de novo)
    estado.tabGraf = { g, ano, mes, rotulos, origens, cont };
    desenharTabelaGraf();
  }

  const DIAS_CURTOS = ['dom.', 'seg.', 'ter.', 'qua.', 'qui.', 'sex.', 'sáb.'];
  function desenharTabelaGraf() {
    const t = estado.tabGraf;
    if (!t) return;
    const { g, ano, mes, rotulos, origens, cont } = t;
    const mostrarZeros = $('#g-zeros').checked;
    $('#ctl-zeros').hidden = g === 'ano';
    $('#g-zeros-txt').textContent = g === 'mes' ? 'Mostrar meses sem movimento' : 'Mostrar dias sem movimento';

    const classe = { petshop: 'c-petshop', banho_tosa: 'c-banho', admin: 'c-admin', teste: 'c-teste' };
    const num = (n) => (n ? String(n) : '<span class="zero">–</span>');
    const totalDe = (o, tipo) => Object.values(cont[o][tipo]).reduce((a, b) => a + b, 0);
    const regLinha = (r) => origens.reduce((a, o) => a + cont[o].reg[r], 0);
    const finLinha = (r) => origens.reduce((a, o) => a + cont[o].fin[r], 0);
    const barra = (fin, reg) => {
      if (!reg || !fin) return `<span class="fin"><span class="fin-n">${num(fin)}</span><span class="fin-vaga"></span></span>`; // sem barra vazia
      const pct = Math.round((fin / reg) * 100);
      return `<span class="fin"><span class="fin-n">${num(fin)}</span><span class="fin-barra" title="${pct}% finalizados"><i style="width:${pct}%"></i></span></span>`;
    };
    const hoje = hojeISO();
    const rotuloLinha = (r, idx) => {
      if (g === 'dia') {
        const d = Number(r), iso = `${ano}-${pad(mes)}-${r}`;
        const sem = new Date(ano, mes - 1, d).getDay();
        return `<span class="dia-n">${r}</span><span class="dia-sem${sem === 0 ? ' dom' : ''}">${DIAS_CURTOS[sem]}</span>${iso === hoje ? '<span class="tag-hoje">hoje</span>' : ''}`;
      }
      if (g === 'mes') return MESES[idx];
      return r;
    };

    const linhas = rotulos.map((r, idx) => ({ r, idx })).filter(({ r }) => mostrarZeros || g === 'ano' || regLinha(r) > 0);
    const nomePeriodo = g === 'dia' ? 'Dia' : g === 'mes' ? 'Mês' : 'Ano';

    const cab1 = `<tr><th rowspan="2" class="col-periodo">${nomePeriodo}</th>${origens.map((o) => `<th colspan="2" class="grupo ${classe[o]}">${NOMES_PAPEL[o]}</th>`).join('')}<th rowspan="2" class="col-total">Total</th></tr>`;
    const cab2 = `<tr>${origens.map((o) => `<th class="sub ${classe[o]}">Registrados</th><th class="sub ${classe[o]} fim-grupo">Finalizados</th>`).join('')}</tr>`;

    let corpo;
    if (!linhas.length) {
      corpo = `<tr class="vazio"><td colspan="${origens.length * 2 + 2}">Nenhum animal registrado neste período.</td></tr>`;
    } else {
      corpo = linhas.map(({ r, idx }) => {
        const iso = g === 'dia' ? `${ano}-${pad(mes)}-${r}` : '';
        return `<tr${iso === hoje ? ' class="linha-hoje"' : ''}><td class="col-periodo">${rotuloLinha(r, idx)}</td>${origens.map((o) =>
          `<td>${num(cont[o].reg[r])}</td><td class="fim-grupo">${barra(cont[o].fin[r], cont[o].reg[r])}</td>`).join('')}<td class="col-total"><b>${num(regLinha(r))}</b></td></tr>`;
      }).join('');
    }
    const regTotal = origens.reduce((a, o) => a + totalDe(o, 'reg'), 0);
    const rodape = `<tr><td class="col-periodo">Total</td>${origens.map((o) =>
      `<td>${totalDe(o, 'reg')}</td><td class="fim-grupo">${barra(totalDe(o, 'fin'), totalDe(o, 'reg'))}</td>`).join('')}<td class="col-total">${regTotal}</td></tr>`;
    const ocultos = rotulos.length - linhas.length;
    const aviso = (!mostrarZeros && g !== 'ano' && ocultos > 0 && linhas.length)
      ? `<caption class="tab-legenda">${ocultos} ${g === 'mes' ? (ocultos === 1 ? 'mês' : 'meses') : (ocultos === 1 ? 'dia' : 'dias')} sem movimento ${ocultos === 1 ? 'oculto' : 'ocultos'}</caption>` : '';
    $('#graf-tabela').innerHTML = `${aviso}<thead>${cab1}${cab2}</thead><tbody>${corpo}</tbody><tfoot>${rodape}</tfoot>`;

    // Celular: cada dia vira um cartão (sem precisar arrastar a tabela para o lado)
    const linhaEmpresa = (o, reg, fin) => `
      <div class="gl-emp ${classe[o]}"><span class="gl-nome">${NOMES_PAPEL[o]}</span>
        <span class="gl-num"><b>${reg}</b> reg.</span>
        <span class="gl-num gl-fin"><b>${fin}</b> fin.${reg ? `<span class="fin-barra"><i style="width:${Math.round((fin / reg) * 100)}%"></i></span>` : ''}</span></div>`;
    const cartao = (titulo, total, r, extra = '') => `
      <div class="gl-item${extra}">
        <div class="gl-topo"><span class="gl-titulo">${titulo}</span><span class="gl-total">${total} ${total === 1 ? 'animal' : 'animais'}</span></div>
        ${origens.filter((o) => !r || cont[o].reg[r] > 0)                     // no dia, só as empresas com animais
          .map((o) => linhaEmpresa(o, r ? cont[o].reg[r] : totalDe(o, 'reg'), r ? cont[o].fin[r] : totalDe(o, 'fin'))).join('')}
      </div>`;
    const cartoes = linhas.length
      ? linhas.map(({ r, idx }) => {
          const iso = g === 'dia' ? `${ano}-${pad(mes)}-${r}` : '';
          return cartao(rotuloLinha(r, idx), regLinha(r), r, iso === hoje ? ' gl-hoje' : '');
        }).join('') + cartao('Total do período', regTotal, null, ' gl-soma')
      : '<p class="gl-vazio">Nenhum animal registrado neste período.</p>';
    const avisoTxt = aviso ? `<p class="gl-aviso">${aviso.replace(/<[^>]+>/g, '')}</p>` : '';
    $('#graf-lista').innerHTML = cartoes + avisoTxt;
  }
  $('#g-zeros').addEventListener('change', desenharTabelaGraf);
  try {
    window.matchMedia('(max-width: 640px)').addEventListener('change', () => {
      if (!$('#aba-graficos').hidden) carregarGraficos();
    });
  } catch (e) { /* navegador antigo: segue sem redesenhar */ }

  /* =================================================================
     Histórico de alterações (só administrador)
     ================================================================= */
  const ROTULOS_CAMPOS = {
    data: 'Data', horario: 'Horário', tutor_nome: 'Tutor', telefone: 'Telefone', pet_nome: 'Animal', pet_idade: 'Idade',
    especie: 'Espécie', pet_sexo: 'Sexo', saude_obs: 'Alergias / saúde', porte: 'Porte', peso_kg: 'Peso (kg)', raca: 'Raça',
    pelagem: 'Pelo', iniciado_em: 'Início do banho', observacoes: 'Observações', servico: 'Serviço', servico_valor: 'Valor', motivo_cancelamento: 'Motivo do cancelamento',
    busca_domicilio: 'Buscar em casa', entrega_domicilio: 'Entregar em casa', entrega_outro_end: 'Entregar em outro endereço',
    end_cep: 'CEP (busca)', end_rua: 'Rua (busca)', end_numero: 'Número (busca)', end_bairro: 'Bairro (busca)', end_cidade: 'Cidade (busca)', end_referencia: 'Referência (busca)',
    ent_cep: 'CEP (entrega)', ent_rua: 'Rua (entrega)', ent_numero: 'Número (entrega)', ent_bairro: 'Bairro (entrega)', ent_cidade: 'Cidade (entrega)', ent_referencia: 'Referência (entrega)'
  };
  const NOMES_ACAO = {
    criado: 'Criado', alterado: 'Alterado', finalizado: 'Finalizado', entregue: 'Entregue', cancelado: 'Cancelado',
    'banho iniciado': 'Banho iniciado', reativado: 'Reativado', reaberto: 'Reaberto', 'entrega desfeita': 'Entrega desfeita', 'tutor avisado': 'Tutor avisado', excluido: 'Excluído'
  };
  function valorLegivel(campo, v) {
    if (v === null || v === undefined || v === '') return '(vazio)';
    if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
    if (campo === 'telefone') return formatarTelefone(String(v));
    if (campo === 'data') return isoParaBR(String(v));
    if (campo === 'horario') return hhmm(String(v));
    if (campo === 'servico_valor') return dinheiro(v);
    if (campo === 'peso_kg') return String(v).replace('.', ',');
    if (campo.endsWith('_cep')) return String(v).replace(/^(\d{5})(\d{3})$/, '$1-$2');
    return String(v);
  }
  const hist = { pagina: 0, por: 50, buscaTimer: null };
  ['#h-periodo', '#h-acao'].forEach((sel) => $(sel).addEventListener('change', () => carregarHistorico(true)));
  $('#h-busca').addEventListener('input', () => { clearTimeout(hist.buscaTimer); hist.buscaTimer = setTimeout(() => carregarHistorico(true), 350); });
  $('#h-mais').addEventListener('click', () => carregarHistorico(false));

  async function carregarHistorico(doZero) {
    if (estado.perfil?.papel !== 'admin') return;
    if (doZero) { hist.pagina = 0; $('#hist-lista').innerHTML = '<p class="vazio">Carregando…</p>'; }
    let q = sb.from('historico').select('*').order('em', { ascending: false });
    const dias = Number($('#h-periodo').value);
    if (dias) q = q.gte('em', new Date(`${somarDias(hojeISO(), -(dias - 1))}T00:00:00-03:00`).toISOString());
    const acao = $('#h-acao').value;
    if (acao === 'reativado') q = q.in('acao', ['reativado', 'reaberto', 'entrega desfeita']);
    else if (acao) q = q.eq('acao', acao);
    const termo = $('#h-busca').value.normalize('NFC').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim();
    if (termo.length >= 2) q = q.or(`pet_nome.ilike.*${termo}*,tutor_nome.ilike.*${termo}*`);
    const de = hist.pagina * hist.por;
    const { data, error } = await q.range(de, de + hist.por - 1);
    if (error) { $('#hist-lista').innerHTML = '<p class="vazio">Não foi possível carregar o histórico.</p>'; return; }
    const linhas = data || [];
    if (doZero) $('#hist-lista').innerHTML = '';
    if (doZero && !linhas.length) { $('#hist-lista').innerHTML = '<p class="vazio">Nenhum registro neste período.</p>'; $('#h-mais').hidden = true; return; }
    $('#hist-lista').insertAdjacentHTML('beforeend', linhas.map(htmlHistorico).join(''));
    hist.pagina++;
    $('#h-mais').hidden = linhas.length < hist.por;
  }
  function htmlHistorico(h) {
    const quando = new Date(h.em);
    const dataTxt = quando.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const horaTxt = quando.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
    const mud = h.mudancas && typeof h.mudancas === 'object'
      ? Object.entries(h.mudancas).map(([c, v]) => {
          const nq = c === 'telefone' || c.endsWith('_cep') || c === 'data' || c === 'horario' ? ' sem-quebra' : '';   // não quebrar no meio
          return `<li><b>${esc(ROTULOS_CAMPOS[c] || c)}:</b> <span class="h-de${nq}">${esc(valorLegivel(c, v && v.de))}</span> → <span class="h-para${nq}">${esc(valorLegivel(c, v && v.para))}</span></li>`;
        }).join('')
      : '';
    const acaoCls = String(h.acao || '').replace(/[^a-z]/g, '');
    return `<article class="hist-item">
      <div class="hist-quando"><b>${esc(horaTxt)}</b><small>${esc(dataTxt)}</small></div>
      <div class="hist-corpo">
        <div class="hist-linha"><span class="tag h-acao h-${esc(acaoCls)}">${esc(NOMES_ACAO[h.acao] || h.acao)}</span>
          <span class="tag tag-${esc(h.usuario_papel || '')}">${esc(h.usuario_nome || 'Sistema')}</span></div>
        <div class="hist-alvo"><b>${esc(h.pet_nome || '—')}</b> · tutor ${esc(h.tutor_nome || '—')}${h.data_agendada ? ` · agendamento de ${isoParaBR(h.data_agendada)}${h.horario ? ` às ${hhmm(h.horario)}` : ''}` : ''}</div>
        ${mud ? `<ul class="hist-mud">${mud}</ul>` : ''}
      </div>
    </article>`;
  }

  /* =================================================================
     Backup: exportar planilha (CSV que abre no Excel) – só administrador
     ================================================================= */
  const CHAVE_BACKUP = 'agendaPet.ultimoBackup';
  const lerUltimoBackup = () => { try { return localStorage.getItem(CHAVE_BACKUP); } catch (e) { return null; } };
  function mostrarStatusBackup() {
    const ult = lerUltimoBackup();
    const el = $('#backup-status');
    if (!ult) { el.innerHTML = '<b class="bk-alerta">Nenhum backup feito neste computador ainda.</b> Recomendado: 1 vez por semana.'; return; }
    const dias = Math.floor((Date.now() - new Date(ult).getTime()) / 86400000);
    el.innerHTML = dias >= 7
      ? `<b class="bk-alerta">Último backup há ${dias} dias (${new Date(ult).toLocaleDateString('pt-BR')}).</b> Faça o backup semanal.`
      : `Último backup em ${new Date(ult).toLocaleDateString('pt-BR')} ${dias === 0 ? '(hoje)' : `(há ${dias} dia${dias > 1 ? 's' : ''})`}. Recomendado: 1 vez por semana.`;
  }
  function lembrarBackup() {
    const ult = lerUltimoBackup();
    if (!ult || Date.now() - new Date(ult).getTime() >= 7 * 86400000) toast('Lembrete: faça o backup semanal na aba Histórico.');
  }
  // célula de planilha: aspas escapadas e sem "fórmulas" (proteção contra injeção em planilha)
  function celula(v) {
    let t = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
    return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  }
  function baixarPlanilha(nome, cabecalho, linhas) {
    const csv = '\uFEFF' + [cabecalho, ...linhas].map((l) => l.map(celula).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = nome; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  async function buscarTudo(tabela, filtro, ordem) {
    let todas = [], de = 0;
    for (;;) {
      let q = sb.from(tabela).select('*');
      q = filtro ? filtro(q) : q;
      const { data, error } = await q.order(ordem, { ascending: true }).range(de, de + 999);
      if (error) throw error;
      todas = todas.concat(data || []);
      if (!data || data.length < 1000) return todas;
      de += 1000;
    }
  }
  const dataHoraBR = (t) => (t ? new Date(t).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '');
  const simNao = (b) => (b ? 'Sim' : 'Não');
  const enderecoTexto = (rua, num, bairro, cidade, cep) => (rua ? [`${rua}, ${num || 's/n'}`, bairro, cidade, cep && String(cep).replace(/^(\d{5})(\d{3})$/, '$1-$2')].filter(Boolean).join(' – ') : '');

  $('#bk-exportar').addEventListener('click', async () => {
    const btn = $('#bk-exportar'); btn.disabled = true; const rotulo = btn.textContent; btn.textContent = 'Gerando…';
    try {
      const per = $('#bk-periodo').value, hoje = hojeISO(), [a, m] = hoje.split('-').map(Number);
      let ini = null, fim = null, sufixo = 'completo';
      if (per === 'mes') { ini = `${a}-${pad(m)}-01`; fim = `${a}-${pad(m)}-${pad(new Date(a, m, 0).getDate())}`; sufixo = `${a}-${pad(m)}`; }
      if (per === 'mes-anterior') { const pa = m === 1 ? a - 1 : a, pm = m === 1 ? 12 : m - 1; ini = `${pa}-${pad(pm)}-01`; fim = `${pa}-${pad(pm)}-${pad(new Date(pa, pm, 0).getDate())}`; sufixo = `${pa}-${pad(pm)}`; }
      if (per === 'ano') { ini = `${a}-01-01`; fim = `${a}-12-31`; sufixo = String(a); }
      const regs = await buscarTudo('agendamentos', ini ? (q) => q.gte('data', ini).lte('data', fim) : null, 'data');
      regs.sort((x, y) => (x.data + x.horario).localeCompare(y.data + y.horario));
      const cab = ['Data', 'Horário', 'Status', 'Empresa', 'Animal', 'Espécie', 'Sexo', 'Idade', 'Raça', 'Porte', 'Peso (kg)', 'Pelo',
        'Alergias / saúde', 'Observações', 'Tutor', 'Telefone', 'Serviço', 'Valor (R$)', 'Buscar em casa', 'Entregar em casa',
        'Endereço de busca', 'Referência (busca)', 'Endereço de entrega', 'Referência (entrega)', 'Motivo do cancelamento',
        'Criado em', 'Finalizado em', 'Entregue em', 'Cancelado em'];
      const linhas = regs.map((r) => [
        isoParaBR(r.data), hhmm(r.horario), NOMES_STATUS[r.status] || r.status, NOMES_PAPEL[r.origem] || r.origem, r.pet_nome, r.especie, r.pet_sexo,
        r.pet_idade, r.raca, r.porte, r.peso_kg != null ? String(r.peso_kg).replace('.', ',') : '', r.pelagem, r.saude_obs, r.observacoes,
        r.tutor_nome, r.telefone ? formatarTelefone(r.telefone) : '', r.servico, r.servico_valor != null ? Number(r.servico_valor).toFixed(2).replace('.', ',') : '',
        simNao(r.busca_domicilio), simNao(r.entrega_domicilio),
        enderecoTexto(r.end_rua, r.end_numero, r.end_bairro, r.end_cidade, r.end_cep), r.end_referencia,
        r.entrega_outro_end ? enderecoTexto(r.ent_rua, r.ent_numero, r.ent_bairro, r.ent_cidade, r.ent_cep) : (r.entrega_domicilio ? enderecoTexto(r.end_rua, r.end_numero, r.end_bairro, r.end_cidade, r.end_cep) : ''),
        r.entrega_outro_end ? r.ent_referencia : '', r.motivo_cancelamento,
        dataHoraBR(r.criado_em), dataHoraBR(r.finalizado_em), dataHoraBR(r.entregue_em), dataHoraBR(r.cancelado_em)
      ]);
      baixarPlanilha(`agenda-pet_${sufixo}_${hoje}.csv`, cab, linhas);
      if (per === 'tudo') { try { localStorage.setItem(CHAVE_BACKUP, new Date().toISOString()); } catch (e) { /* sem armazenamento */ } }
      mostrarStatusBackup();
      toast(`Planilha gerada com ${regs.length} agendamento(s).`, 'ok');
    } catch (e) {
      toast('Não foi possível gerar a planilha.', 'erro');
    } finally { btn.disabled = false; btn.textContent = rotulo; }
  });
  $('#bk-historico').addEventListener('click', async () => {
    const btn = $('#bk-historico'); btn.disabled = true;
    try {
      const regs = await buscarTudo('historico', null, 'em');
      const linhas = regs.map((h) => [dataHoraBR(h.em), NOMES_ACAO[h.acao] || h.acao, h.usuario_nome, NOMES_PAPEL[h.usuario_papel] || h.usuario_papel,
        h.pet_nome, h.tutor_nome, h.data_agendada ? isoParaBR(h.data_agendada) : '', h.horario ? hhmm(h.horario) : '',
        h.mudancas ? Object.entries(h.mudancas).map(([c, v]) => `${ROTULOS_CAMPOS[c] || c}: ${valorLegivel(c, v && v.de)} → ${valorLegivel(c, v && v.para)}`).join(' | ') : '']);
      baixarPlanilha(`agenda-pet_historico_${hojeISO()}.csv`, ['Quando', 'Ação', 'Usuário', 'Papel', 'Animal', 'Tutor', 'Data agendada', 'Horário', 'Alterações'], linhas);
      toast(`Histórico exportado (${regs.length} registro(s)).`, 'ok');
    } catch (e) {
      toast('Não foi possível exportar o histórico.', 'erro');
    } finally { btn.disabled = false; }
  });

  /* =================================================================
     Tutor: criar conta (celular + senha) e área "Meus pets".
     O tutor nunca vê agenda, gráficos ou histórico: só ele e os pets dele.
     ================================================================= */
  const DOMINIO_TUTOR = C.DOMINIO_TUTOR || 'agendapets.vercel.app';
  const telTutor = (t) => {
    let d = soDigitos(t);
    if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
    return d.length === 10 || d.length === 11 ? d : null;
  };
  function emailDoLogin(txt) {
    if (txt.includes('@')) return txt;
    const tel = telTutor(txt);
    return tel ? `${tel}@${DOMINIO_TUTOR}` : null;
  }
  // Tutor esqueceu a senha: pede para a loja pelo WhatsApp DELE (a loja confere o número e o
  // administrador cria uma senha nova em "🔑 Senha do tutor"). Sem custo e sem conta na Meta.
  function linkPedidoSenha(tel) {
    const loja = soDigitos(C.WHATSAPP_LOJA || '');
    if (loja.length < 10) return '';
    const destino = loja.length <= 11 ? (C.DDI || '55') + loja : loja;
    const texto = `Olá! Esqueci minha senha do Agenda Pet. Meu celular de cadastro é ${formatarTelefone(tel)}. Pode criar uma senha nova para mim?`;
    return `https://wa.me/${destino}?text=${encodeURIComponent(texto)}`;
  }
  function esqueciSenhaTutor(digitado) {
    const temLoja = soDigitos(C.WHATSAPP_LOJA || '').length >= 10;
    if (!temLoja) {
      return janela({ titulo: 'Esqueci minha senha', texto: 'Peça para a loja criar uma senha nova para você. Depois, entre com o seu celular e a senha nova.' });
    }
    const caixa = document.createElement('div');
    caixa.className = 'motivo-cancel esqueci-tutor';
    caixa.innerHTML = `<label>Seu celular de cadastro<input id="es-tel" inputmode="tel" placeholder="(00) 00000-0000" maxlength="15" autocomplete="tel"></label>
      <a id="es-whats" class="btn btn-ok btn-largo" target="_blank" rel="noopener" aria-disabled="true">Pedir senha nova pelo WhatsApp</a>
      <p class="nota" id="es-dica">Digite o celular com DDD para liberar o botão.</p>`;
    const campo = caixa.querySelector('#es-tel'), link = caixa.querySelector('#es-whats'), dica = caixa.querySelector('#es-dica');
    const atualizar = () => {
      campo.value = formatarTelefone(campo.value);
      const tel = telTutor(campo.value);
      if (tel) { link.href = linkPedidoSenha(tel); link.removeAttribute('aria-disabled'); dica.textContent = 'Abre o seu WhatsApp com a mensagem pronta. É só enviar.'; }
      else { link.removeAttribute('href'); link.setAttribute('aria-disabled', 'true'); dica.textContent = 'Digite o celular com DDD para liberar o botão.'; }
    };
    campo.value = digitado || '';
    campo.addEventListener('input', atualizar);
    link.addEventListener('click', (e) => {
      if (!link.getAttribute('href')) { e.preventDefault(); campo.classList.add('invalido'); campo.focus(); return; }
      toast('Quando a loja responder com a senha nova, entre com o seu celular e essa senha.', 'ok');
    });
    atualizar();
    return janela({ titulo: 'Esqueci minha senha',
      texto: 'Mande o pedido do seu próprio WhatsApp: a loja confere o número e cria uma senha nova para você.',
      extra: caixa, botoes: [{ rotulo: 'Voltar', valor: false }] });
  }
  const querCadastro = () => /\/cadastro\/?$/.test(location.pathname) || /^#cadastro/.test(location.hash);
  function mostrarCriarConta() {
    $('#tela-login').hidden = true;
    $('#tela-tutor').hidden = true;
    $('#tela-conta').hidden = false;
    $('#conta-erro').textContent = '';
    $('#c-nome').focus();
  }
  $('#btn-criar-conta').addEventListener('click', () => { history.replaceState(null, '', '#cadastro'); mostrarCriarConta(); });
  $('#c-voltar').addEventListener('click', () => {
    history.replaceState(null, '', location.pathname.replace(/\/cadastro\/?$/, '/'));
    $('#tela-conta').hidden = true; $('#tela-login').hidden = false;
    const tel = telTutor($('#c-tel').value);
    if (tel) $('#login-email').value = formatarTelefone(tel);
    $('#login-email').focus();
  });
  $('#c-tel').addEventListener('input', () => { $('#c-tel').value = formatarTelefone($('#c-tel').value); });
  const TEXTO_PRIVACIDADE = 'Usamos seus dados (nome, celular e endereço) e os dos seus pets (características, saúde e observações) só para '
    + 'agendar os atendimentos, preparar o banho e tosa com segurança e fazer o leva e traz. Não vendemos nem passamos seus dados para ninguém. '
    + 'Você pode corrigir seus dados quando quiser aqui na sua conta e pode pedir para a loja apagar tudo a qualquer momento.';
  $('#c-privacidade').addEventListener('click', () => janela({ titulo: 'Aviso de privacidade', texto: TEXTO_PRIVACIDADE }));

  $('#form-conta').addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('#conta-erro');
    const nome = nomeProprio($('#c-nome').value), tel = telTutor($('#c-tel').value);
    const senha = $('#c-senha').value, senha2 = $('#c-senha2').value;
    const marca = (el, ok) => { el.classList.toggle('invalido', !ok); return ok; };
    const problemas = [];
    if (!marca($('#c-nome'), nome.length >= 2)) problemas.push('Informe seu nome.');
    if (!marca($('#c-tel'), !!tel)) problemas.push('Celular inválido: use DDD + número.');
    if (!marca($('#c-senha'), senha.length >= 6 && senha.length <= 9)) problemas.push('A senha precisa ter de 6 a 9 caracteres (letras, números ou símbolos).');
    else if (!marca($('#c-senha2'), senha === senha2)) problemas.push('As duas senhas não são iguais.');
    if (!$('#c-lgpd').checked) problemas.push('Marque a autorização para guardar os dados.');
    erro.textContent = problemas.join(' ');
    if (problemas.length) return;
    const btn = $('#c-enviar'); btn.disabled = true; btn.textContent = 'Criando sua conta…';
    try {
      const { data, error } = await sb.functions.invoke('criar-conta-tutor', { body: { nome, telefone: tel, senha, lgpd: true } });
      let resp = data;
      if (error && error.context && typeof error.context.json === 'function') { try { resp = await error.context.json(); } catch (x) { /* sem corpo */ } }
      if (!resp || !resp.ok) {
        erro.textContent = (resp && resp.erro) || 'Não foi possível criar a conta agora. Verifique a internet e tente de novo.';
        if (resp && resp.codigo === 'ja_tem_conta') { $('#login-email').value = formatarTelefone(tel); }
        return;
      }
      const { data: ses, error: erroLogin } = await sb.auth.signInWithPassword({ email: `${tel}@${DOMINIO_TUTOR}`, password: senha });
      if (erroLogin || !ses || !ses.session) { erro.textContent = 'Conta criada! Agora entre com o seu celular e a senha.'; return; }
      estado.primeiroAcesso = true;
      $('#form-conta').reset();
      history.replaceState(null, '', location.pathname.replace(/\/cadastro\/?$/, '/'));
      await entrar(ses.session);
    } finally { btn.disabled = false; btn.textContent = 'Criar minha conta'; }
  });

  // ---------- área do tutor ----------
  const tt = {
    nome: $('#t-nome'), tel: $('#t-tel'), cep: $('#t-cep'), rua: $('#t-rua'), numero: $('#t-numero'),
    bairro: $('#t-bairro'), cidade: $('#t-cidade'), referencia: $('#t-referencia')
  };
  const cepTutor = ligarCep({ cep: tt.cep, rua: tt.rua, numero: tt.numero, bairro: tt.bairro, cidade: tt.cidade, status: $('#t-cep-status') });
  const pf = { id: $('#p-id'), nome: $('#p-nome'), idade: $('#p-idade'), idadeUn: $('#p-idade-un'), peso: $('#p-peso'),
    raca: $('#p-raca'), saude: $('#p-saude'), obs: $('#p-obs') };
  pf.idade.addEventListener('input', () => { pf.idade.value = soDigitos(pf.idade.value).slice(0, 2); });
  pf.peso.addEventListener('input', () => { pf.peso.value = pf.peso.value.replace(/[^\d,.]/g, '').replace('.', ','); });

  async function entrarTutor(tutor) {
    estado.tutor = tutor;
    $('#tela-login').hidden = true; $('#tela-conta').hidden = true; $('#tela-app').hidden = true;
    $('#tela-tutor').hidden = false;
    $('#tt-ola').textContent = `Olá, ${tutor.nome.split(' ')[0]}!`;
    preencherDadosTutor();
    const whats = soDigitos(C.WHATSAPP_LOJA || '');
    const linkWhats = $('#tt-whats');
    linkWhats.hidden = whats.length < 10;
    if (whats.length >= 10) linkWhats.href = `https://wa.me/${whats.length <= 11 ? (C.DDI || '55') + whats : whats}?text=${encodeURIComponent(`Olá! Sou ${tutor.nome} e quero agendar banho e tosa.`)}`;
    fecharFormPet();
    await carregarPetsTutor();
    const primeiro = !!estado.primeiroAcesso;
    estado.primeiroAcesso = false;
    $('#tela-tutor').classList.toggle('primeiro-acesso', primeiro);
    $('#t-salvar').textContent = primeiro ? 'Salvar e continuar: cadastrar meus pets' : 'Salvar meus dados';
    const passos = $('#tt-passos');
    passos.hidden = !primeiro;
    if (primeiro) {
      passos.innerHTML = '<b>✅ Conta criada!</b> Falta pouco: <ol><li>Confira seus dados e o endereço abaixo e toque em salvar.</li><li>Depois cadastre seus pets.</li></ol>';
      tt.cep.focus();
    }
  }
  function preencherDadosTutor() {
    const t = estado.tutor;
    tt.nome.value = t.nome || '';
    tt.tel.value = formatarTelefone(t.telefone || '');
    tt.cep.value = t.end_cep ? t.end_cep.replace(/^(\d{5})(\d{3})$/, '$1-$2') : '';
    tt.rua.value = t.end_rua || ''; tt.numero.value = t.end_numero || ''; tt.bairro.value = t.end_bairro || '';
    tt.cidade.value = t.end_cidade || ''; tt.referencia.value = t.end_referencia || '';
    cepTutor.carregado();
    $('#tutor-erro').textContent = '';
  }
  $('#form-tutor').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nome = nomeProprio(tt.nome.value), cep = soDigitos(tt.cep.value);
    const erro = $('#tutor-erro');
    tt.nome.classList.toggle('invalido', nome.length < 2);
    tt.cep.classList.toggle('invalido', !!cep && cep.length !== 8);
    if (nome.length < 2) { erro.textContent = 'Informe seu nome.'; return; }
    if (cep && cep.length !== 8) { erro.textContent = 'CEP incompleto.'; return; }
    if (tt.rua.value.trim() && !tt.numero.value.trim()) { tt.numero.classList.add('invalido'); erro.textContent = 'Informe o número da casa.'; return; }
    const dados = {
      nome, end_cep: cep || null, end_rua: nomeProprio(tt.rua.value) || null, end_numero: tt.numero.value.trim() || null,
      end_bairro: nomeProprio(tt.bairro.value) || null, end_cidade: tt.cidade.value.trim() || null, end_referencia: tt.referencia.value.trim() || null
    };
    const btn = $('#t-salvar'); btn.disabled = true;
    const { error } = await sb.from('tutores').update(dados).eq('id', estado.tutor.id);
    btn.disabled = false;
    if (error) { erro.textContent = 'Não foi possível salvar agora. Verifique a internet e tente de novo.'; return; }
    Object.assign(estado.tutor, dados);
    preencherDadosTutor();
    $$('#form-tutor .invalido').forEach((el) => el.classList.remove('invalido'));
    $('#tt-ola').textContent = `Olá, ${nome.split(' ')[0]}!`;
    toast('Seus dados foram salvos.', 'ok');
    if ($('#tela-tutor').classList.contains('primeiro-acesso')) {
      $('#tela-tutor').classList.remove('primeiro-acesso');
      $('#t-salvar').textContent = 'Salvar meus dados';
      $('#tt-passos').innerHTML = '<b>Agora cadastre seus pets.</b> Preencha os dados com atenção: eles ajudam a equipe a preparar o banho e o transporte com segurança.';
      abrirFormPet();
    }
  });

  async function carregarPetsTutor() {
    const caixa = $('#tt-pets');
    const { data, error } = await sb.from('pets').select('*').eq('tutor_id', estado.tutor.id).eq('ativo', true).order('nome');
    if (error) { caixa.innerHTML = '<p class="vazio">Não foi possível carregar seus pets agora.</p>'; return; }
    estado.petsTutor = data || [];
    caixa.innerHTML = estado.petsTutor.length ? estado.petsTutor.map((p) => {
      const idade = textoIdadeDe(p.nascimento);
      const carac = [p.especie === 'Felino' ? 'Gato' : p.especie === 'Canino' ? 'Cachorro' : '', p.sexo, idade, p.raca, p.porte && `porte ${p.porte.toLowerCase()}`,
        p.pelagem && `pelo ${p.pelagem.toLowerCase()}`, p.peso_kg && `${String(Number(p.peso_kg)).replace('.', ',')} kg`].filter(Boolean).join(' · ');
      const falta = !p.especie || !p.porte || !p.raca || !p.pelagem || !p.peso_kg || p.tem_saude == null;
      return `<article class="tt-pet">
        <div class="tt-pet-info"><b>${p.especie === 'Felino' ? '🐱' : '🐶'} ${esc(p.nome)}</b><span>${esc(carac)}</span>
          ${p.tem_saude ? `<span class="tag tag-saude">⚠️ ${esc((p.saude_obs || 'cuidados de saúde').slice(0, 60))}</span>` : ''}
          ${falta ? '<span class="tag tag-novo">Complete o cadastro</span>' : ''}</div>
        <button type="button" class="btn btn-fantasma btn-pequeno" data-editar-pet="${esc(p.id)}">Editar</button>
      </article>`;
    }).join('') : '<p class="vazio">Você ainda não cadastrou nenhum pet. Toque em <b>+ Cadastrar pet</b>.</p>';
  }
  $('#tt-pets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-editar-pet]');
    if (b) abrirFormPet((estado.petsTutor || []).find((p) => p.id === b.dataset.editarPet));
  });
  $('#tt-novo-pet').addEventListener('click', () => abrirFormPet());

  function atualizarRacasTutor() {
    const esp = radio('p-especie');
    const lista = (window.RACAS && esp && window.RACAS[esp]) || [];
    $('#p-racas').innerHTML = lista.map((r) => `<option value="${esc(r)}"></option>`).join('');
    pf.raca.placeholder = esp ? 'Comece a digitar (ou SRD, sem raça definida)' : 'Escolha a espécie primeiro';
  }
  $$('input[name="p-especie"]').forEach((r) => r.addEventListener('change', atualizarRacasTutor));
  function mostrarSaudeTutor() {
    const sim = radio('p-tem-saude') === 'sim';
    $('#p-saude-campo').hidden = !sim;
    if (sim && !pf.saude.value) pf.saude.focus();
  }
  $$('input[name="p-tem-saude"]').forEach((r) => r.addEventListener('change', mostrarSaudeTutor));

  function abrirFormPet(p) {
    $('#form-pet').reset();
    $$('#form-pet .invalido').forEach((el) => el.classList.remove('invalido'));
    $('#pet-erro').textContent = '';
    pf.id.value = p ? p.id : '';
    $('#tt-pet-titulo').textContent = p ? `Editar: ${p.nome}` : 'Cadastrar pet';
    $('#p-remover').hidden = !p;
    if (p) {
      pf.nome.value = p.nome || '';
      marcarRadio('p-especie', p.especie); marcarRadio('p-sexo', p.sexo);
      marcarRadio('p-tem-saude', p.tem_saude === true ? 'sim' : p.tem_saude === false ? 'nao' : null);
      pf.saude.value = p.saude_obs || '';
      const i = idadeDe(p.nascimento);
      pf.idade.value = i ? String(i.n) : ''; pf.idadeUn.value = i ? i.un : 'anos';
      pf.peso.value = p.peso_kg ? String(Number(p.peso_kg)).replace('.', ',') : '';
      marcarRadio('p-porte', p.porte); pf.raca.value = p.raca || ''; marcarRadio('p-pelagem', p.pelagem);
      pf.obs.value = p.observacoes || '';
    }
    atualizarRacasTutor();
    mostrarSaudeTutor();
    $('#tt-pet-painel').hidden = false;
    $('#tt-pets-painel').hidden = true;
    $('#tt-pet-painel').scrollIntoView({ block: 'start' });
    pf.nome.focus({ preventScroll: true });
  }
  function fecharFormPet() {
    $('#tt-pet-painel').hidden = true;
    $('#tt-pets-painel').hidden = false;
  }
  $('#p-cancelar').addEventListener('click', () => { fecharFormPet(); $('#tt-pets-painel').scrollIntoView({ block: 'start' }); });

  $('#form-pet').addEventListener('submit', async (e) => {
    e.preventDefault();
    const erros = [];
    const marca = (el, ok) => { if (el) el.classList.toggle('invalido', !ok); return ok; };
    const nome = nomeProprio(pf.nome.value);
    const especie = radio('p-especie'), temSaude = radio('p-tem-saude'), porte = radio('p-porte'), pelagem = radio('p-pelagem');
    const peso = pf.peso.value ? Number(pf.peso.value.replace(',', '.')) : null;
    const idade = parseInt(pf.idade.value, 10);
    if (!marca(pf.nome, nome.length >= 1)) erros.push('Informe o nome do pet.');
    if (!marca(pf.idade, !idade || (pf.idadeUn.value === 'meses' ? idade <= 420 : idade <= 35))) erros.push('Idade inválida: um pet não passa de 35 anos.');
    if (!marca($('#p-especie-grupo'), !!especie)) erros.push('Escolha se é cachorro ou gato.');
    if (!marca($('#p-tem-saude-grupo'), !!temSaude)) erros.push('Responda se tem alergia ou problema de saúde.');
    if (temSaude === 'sim' && !marca(pf.saude, pf.saude.value.trim().length > 0)) erros.push('Descreva as alergias ou cuidados.');
    if (!marca(pf.peso, peso !== null && peso > 0 && peso < 999)) erros.push('Informe o peso aproximado (ex.: 8,5).');
    if (!marca($('#p-porte-grupo'), !!porte)) erros.push('Escolha o porte.');
    if (!marca(pf.raca, pf.raca.value.trim().length > 0)) erros.push('Informe a raça (ou SRD).');
    if (!marca($('#p-pelagem-grupo'), !!pelagem)) erros.push('Escolha a pelagem.');
    $('#pet-erro').textContent = erros.join(' ');
    if (erros.length) { const el = $('#form-pet .invalido'); if (el) el.scrollIntoView({ block: 'center' }); return; }

    let nascimento = null;
    if (idade || idade === 0) {
      const d = new Date(`${hojeISO()}T12:00:00`);
      if (pf.idadeUn.value === 'meses') d.setMonth(d.getMonth() - idade); else d.setFullYear(d.getFullYear() - idade);
      nascimento = d.toISOString().slice(0, 10);
    }
    const editando = (estado.petsTutor || []).find((p) => p.id === pf.id.value);
    // se a idade não mudou, mantém a data de nascimento que já estava salva
    if (editando && editando.nascimento) {
      const i = idadeDe(editando.nascimento);
      if (i && i.n === idade && i.un === pf.idadeUn.value) nascimento = editando.nascimento;
    }
    const dados = {
      nome, especie, sexo: radio('p-sexo'), nascimento, porte, raca: pf.raca.value.trim(), pelagem, peso_kg: peso,
      tem_saude: temSaude === 'sim', saude_obs: temSaude === 'sim' ? pf.saude.value.trim() : null, observacoes: pf.obs.value.trim() || null
    };
    const btn = $('#p-salvar'); btn.disabled = true;
    const { error } = editando
      ? await sb.from('pets').update(dados).eq('id', editando.id)
      : await sb.from('pets').insert({ ...dados, tutor_id: estado.tutor.id });
    btn.disabled = false;
    if (error) {
      $('#pet-erro').textContent = /Limite/.test(error.message || '') ? 'Limite de pets atingido. Fale com a loja.'
        : /Idade/.test(error.message || '') ? 'Idade inválida: um pet não passa de 35 anos.'
        : 'Não foi possível salvar agora. Verifique a internet e tente de novo.';
      return;
    }
    toast(editando ? `${nome} atualizado.` : `${nome} cadastrado! 🐾`, 'ok');
    $('#tt-passos').hidden = true;
    fecharFormPet();
    await carregarPetsTutor();
    $('#tt-pets-painel').scrollIntoView({ block: 'start' });
  });
  $('#p-remover').addEventListener('click', async () => {
    const p = (estado.petsTutor || []).find((x) => x.id === pf.id.value);
    if (!p) return;
    const ok = await confirmar('Remover pet', `Tirar ${p.nome} da sua lista? Os atendimentos antigos continuam guardados na loja.`, 'Remover', 'btn-perigo');
    if (!ok) return;
    const { error } = await sb.from('pets').update({ ativo: false }).eq('id', p.id);
    if (error) return toast('Não foi possível remover agora.', 'erro');
    toast(`${p.nome} removido da lista.`, 'ok');
    fecharFormPet();
    carregarPetsTutor();
  });
  // campo corrigido: tira o vermelho assim que a pessoa mexe
  ['#form-conta', '#form-pet', '#form-tutor'].forEach((sel) => {
    const limpar = (e) => {
      const el = e.target;
      if (el.matches('input[type=radio], input[type=checkbox]')) { const g = el.closest('.opcoes'); if (g) g.classList.remove('invalido'); }
      else if (el.value && el.value.trim()) el.classList.remove('invalido');
    };
    $(sel).addEventListener('input', limpar);
    $(sel).addEventListener('change', limpar);
  });
  $('#tt-sair').addEventListener('click', () => sb.auth.signOut());
  $('#tt-trocar-senha').addEventListener('click', async () => {
    const caixa = document.createElement('div');
    caixa.className = 'motivo-cancel';
    caixa.innerHTML = `<label>Nova senha<input id="ts-senha" type="password" autocomplete="new-password" maxlength="9" placeholder="De 6 a 9 caracteres"></label>
      <label>Repita a nova senha<input id="ts-senha2" type="password" autocomplete="new-password" maxlength="9"></label>
      <p class="erro-texto" id="ts-erro" role="alert"></p>`;
    let senha = '';
    const ok = await janela({ titulo: 'Trocar minha senha', texto: 'Escolha a nova senha: de 6 a 9 caracteres (letras, números ou símbolos).', extra: caixa,
      botoes: [{ rotulo: 'Voltar', valor: false }, { rotulo: 'Salvar', classe: 'btn-primario', valor: true, validar: () => {
        const a = caixa.querySelector('#ts-senha').value, b = caixa.querySelector('#ts-senha2').value;
        const erro = a.length < 6 || a.length > 9 ? 'A senha precisa ter de 6 a 9 caracteres.' : a !== b ? 'As duas senhas não são iguais.' : '';
        caixa.querySelector('#ts-erro').textContent = erro;
        if (erro) return false;
        senha = a; return true;
      } }] });
    if (!ok) return;
    const { error } = await sb.auth.updateUser({ password: senha });
    toast(error ? 'Não foi possível trocar a senha. Tente outra senha.' : 'Senha trocada.', error ? 'erro' : 'ok');
  });

  // ---------- loja: administrador cria/troca a senha de acesso do tutor ----------
  async function senhaDoTutor() {
    const r = estado.cliente;
    if (!r || !estado.perfil || estado.perfil.papel !== 'admin') return;
    const caixa = document.createElement('div');
    caixa.className = 'motivo-cancel';
    caixa.innerHTML = `<label>Nova senha do tutor<input id="st-senha" type="text" autocomplete="off" maxlength="9" placeholder="De 6 a 9 caracteres"></label>
      <p class="erro-texto" id="st-erro" role="alert"></p>`;
    let senha = '';
    const ok = await janela({ titulo: `Acesso de ${r.tutor_nome}`,
      texto: `O tutor entra com o celular ${formatarTelefone(r.telefone)} e esta senha. Passe a senha para ele e peça para trocar depois em "Trocar minha senha".`,
      extra: caixa,
      botoes: [{ rotulo: 'Voltar', valor: false }, { rotulo: 'Salvar senha', classe: 'btn-primario', valor: true, validar: () => {
        senha = caixa.querySelector('#st-senha').value.trim();
        if (senha.length < 6 || senha.length > 9) { caixa.querySelector('#st-erro').textContent = 'A senha precisa ter de 6 a 9 caracteres.'; return false; }
        return true;
      } }] });
    if (!ok) return;
    const { data, error } = await sb.functions.invoke('senha-tutor', { body: { tutor_id: r.tutor_id, senha } });
    let resp = data;
    if (error && error.context && typeof error.context.json === 'function') { try { resp = await error.context.json(); } catch (x) { /* sem corpo */ } }
    if (!resp || !resp.ok) return toast((resp && resp.erro) || 'Não foi possível salvar a senha agora.', 'erro');
    toast(resp.acao === 'acesso_liberado' ? 'Acesso liberado: o tutor já pode entrar com o celular e essa senha.' : 'Senha do tutor trocada.', 'ok');
  }
  fichaPet.addEventListener('click', (e) => { if (e.target.closest('#ficha-senha')) senhaDoTutor(); });

  iniciar();
})();
