// =====================================================================
// AGENDA PET – Edge Function "senha-tutor"
// Só o ADMINISTRADOR usa: cria uma senha nova para o tutor que esqueceu,
// ou libera o acesso (celular + senha) de um tutor que a loja cadastrou.
//
// Secrets opcionais: DOMINIO_TUTOR (padrão: agendapets.vercel.app)
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, erro: 'Método não permitido.' }, 405);
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const adm = createClient(url, chaveAdmin(), { auth: { persistSession: false, autoRefreshToken: false } });

    // quem está pedindo? (precisa ser administrador)
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: quem } = await adm.auth.getUser(token);
    if (!quem?.user) return json({ ok: false, erro: 'Entre no sistema de novo.' }, 401);
    const { data: perfil } = await adm.from('perfis').select('papel').eq('id', quem.user.id).maybeSingle();
    if (perfil?.papel !== 'admin') return json({ ok: false, erro: 'Só o administrador pode criar senha para tutor.' }, 403);

    const corpo = await req.json().catch(() => ({}));
    const senha = String(corpo.senha || '');
    if (senha.length < 6 || senha.length > 9) return json({ ok: false, erro: 'A senha precisa ter de 6 a 9 caracteres.' }, 400);
    const { data: tutor } = await adm.from('tutores').select('id, user_id, telefone, nome').eq('id', String(corpo.tutor_id || '')).maybeSingle();
    if (!tutor) return json({ ok: false, erro: 'Tutor não encontrado.' }, 404);

    if (tutor.user_id) {
      const { error } = await adm.auth.admin.updateUserById(tutor.user_id, { password: senha });
      if (error) return json({ ok: false, erro: 'Não foi possível trocar a senha. Tente outra senha.' }, 400);
      return json({ ok: true, acao: 'senha_trocada' });
    }
    // tutor cadastrado pela loja: cria o acesso agora
    const dominio = Deno.env.get('DOMINIO_TUTOR') || 'agendapets.vercel.app';
    const { data: criado, error } = await adm.auth.admin.createUser({
      email: `${tutor.telefone}@${dominio}`, password: senha, email_confirm: true, user_metadata: { tipo: 'tutor', nome: tutor.nome }
    });
    if (error || !criado?.user) return json({ ok: false, erro: 'Não foi possível liberar o acesso. Tente outra senha.' }, 400);
    const { error: erroLiga } = await adm.from('tutores').update({ user_id: criado.user.id }).eq('id', tutor.id);
    if (erroLiga) {
      await adm.auth.admin.deleteUser(criado.user.id);
      return json({ ok: false, erro: 'Não foi possível liberar o acesso agora.' }, 500);
    }
    return json({ ok: true, acao: 'acesso_liberado' });
  } catch (_e) {
    return json({ ok: false, erro: 'Não foi possível concluir agora.' }, 500);
  }
});
