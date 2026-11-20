// =====================================================================
// AGENDA PET – Edge Function "criar-conta-tutor"
// O tutor cria a própria conta (nome + celular + senha) pela página /cadastro.
// O login dele é o celular: por baixo, a conta usa um e-mail interno
// "<celular>@<DOMINIO_TUTOR>" que nunca recebe mensagens.
//
// Proteções:
//  - celular que já tem conta, ou que a loja já cadastrou, não é "tomado" por outra pessoa
//  - no máximo 5 contas por hora vindas do mesmo aparelho/rede (evita robôs)
//  - a conta criada NÃO tem acesso à agenda: só aos próprios dados e pets
//
// Secrets opcionais (Supabase > Edge Functions > Secrets):
//   DOMINIO_TUTOR (padrão: agendapets.vercel.app) – tem que ser igual ao do config.js
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// chave de administrador: a nova (SUPABASE_SECRET_KEYS) ou a antiga (service_role)
function chaveAdmin(): string {
  try {
    const novas = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    const k = novas.default || Object.values(novas)[0];
    if (typeof k === 'string' && k) return k;
  } catch (_e) { /* projeto só com as chaves antigas */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// "(15) 99887-6655" / "+55 15 99887 6655" -> "15998876655"
function normalizarTel(t: string): string | null {
  let d = String(t || '').replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? d : null;
}
const nomeProprio = (t: string) => String(t || '').trim().replace(/\s+/g, ' ').toLowerCase()
  .replace(/(^|\s)(\p{L})/gu, (_m, e, l) => e + l.toUpperCase()).replace(/\b(Da|De|Do|Das|Dos|E)\b/g, (p) => p.toLowerCase());

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, erro: 'Método não permitido.' }, 405);
  try {
    const corpo = await req.json().catch(() => ({}));
    const nome = nomeProprio(String(corpo.nome || '')).slice(0, 120);
    const tel = normalizarTel(String(corpo.telefone || ''));
    const senha = String(corpo.senha || '');
    if (nome.length < 2) return json({ ok: false, erro: 'Informe seu nome.' }, 400);
    if (!tel) return json({ ok: false, erro: 'Celular inválido. Use DDD + número, ex.: (15) 99999-9999.' }, 400);
    if (senha.length < 6 || senha.length > 9) return json({ ok: false, erro: 'A senha precisa ter de 6 a 9 caracteres.' }, 400);
    if (corpo.lgpd !== true) return json({ ok: false, erro: 'É preciso aceitar o aviso de privacidade.' }, 400);

    const adm = createClient(Deno.env.get('SUPABASE_URL')!, chaveAdmin(),
      { auth: { persistSession: false, autoRefreshToken: false } });

    // limite: 5 contas por hora por rede
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'desconhecido';
    const umaHora = new Date(Date.now() - 3600_000).toISOString();
    await adm.from('tentativas_conta').delete().lt('em', new Date(Date.now() - 86400_000).toISOString());
    const { count } = await adm.from('tentativas_conta').select('ip', { count: 'exact', head: true }).eq('ip', ip).gte('em', umaHora);
    if ((count || 0) >= 5) return json({ ok: false, erro: 'Muitas contas criadas por aqui. Tente de novo mais tarde ou fale com a loja.' }, 429);
    await adm.from('tentativas_conta').insert({ ip });

    // celular já usado?
    const { data: existente } = await adm.from('tutores').select('id, user_id').eq('telefone', tel).maybeSingle();
    if (existente?.user_id) return json({ ok: false, codigo: 'ja_tem_conta', erro: 'Este celular já tem conta. Entre com o celular e a senha.' }, 409);
    if (existente) return json({ ok: false, codigo: 'cadastro_loja', erro: 'Este celular já tem cadastro na loja. Fale com a loja para liberar seu acesso.' }, 409);

    const dominio = Deno.env.get('DOMINIO_TUTOR') || 'agendapets.vercel.app';
    const { data: criado, error: erroConta } = await adm.auth.admin.createUser({
      email: `${tel}@${dominio}`, password: senha, email_confirm: true,
      user_metadata: { tipo: 'tutor', nome }
    });
    if (erroConta || !criado?.user) {
      const msg = String(erroConta?.message || '');
      if (/already|registered|exists/i.test(msg)) return json({ ok: false, codigo: 'ja_tem_conta', erro: 'Este celular já tem conta. Entre com o celular e a senha.' }, 409);
      if (/password/i.test(msg)) return json({ ok: false, erro: 'Senha fraca. Use pelo menos 6 caracteres, misturando letras e números.' }, 400);
      return json({ ok: false, erro: 'Não foi possível criar a conta agora. Tente de novo.' }, 500);
    }

    const { error: erroTutor } = await adm.from('tutores').insert({
      user_id: criado.user.id, nome, telefone: tel, origem: 'tutor', conferido: false, lgpd_aceite_em: new Date().toISOString()
    });
    if (erroTutor) {
      await adm.auth.admin.deleteUser(criado.user.id);           // desfaz: nada fica pela metade
      return json({ ok: false, erro: 'Não foi possível criar a conta agora. Tente de novo.' }, 500);
    }
    return json({ ok: true });
  } catch (_e) {
    return json({ ok: false, erro: 'Não foi possível criar a conta agora. Tente de novo.' }, 500);
  }
});
