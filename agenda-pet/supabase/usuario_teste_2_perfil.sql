-- =====================================================================
-- AGENDA PET – Usuário de TESTE  (PASSO 2 de 2)
-- Antes: crie o usuário em Authentication > Users > Add user > Create new user
--        (marque "Auto Confirm User"). Troque o e-mail abaixo pelo que você usou
--        e rode este arquivo no SQL Editor (New query > Run).
-- Pode rodar de novo sem problema (não dá conflito).
-- =====================================================================
insert into public.perfis (id, nome, papel)
select id, 'Teste', 'teste' from auth.users where email = 'teste@agendapet.com'
on conflict (id) do update set nome = excluded.nome, papel = excluded.papel;

-- Conferência: deve listar os 4 usuários com seus papéis
select p.nome, p.papel, u.email
from public.perfis p join auth.users u on u.id = p.id
order by p.papel;
