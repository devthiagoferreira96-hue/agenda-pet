-- =====================================================================
-- AGENDA PET – Ligar os 3 usuários aos seus papéis
-- Antes: crie os 3 usuários em Authentication > Users > Add user
--        (marque "Auto Confirm User"). Depois troque os e-mails abaixo
--        pelos que você usou e rode este arquivo no SQL Editor.
-- =====================================================================

insert into public.perfis (id, nome, papel)
select id, 'Administrador', 'admin'      from auth.users where email = 'admin@exemplo.com'
on conflict (id) do update set nome = excluded.nome, papel = excluded.papel;

insert into public.perfis (id, nome, papel)
select id, 'Pet Shop', 'petshop'         from auth.users where email = 'petshop@exemplo.com'
on conflict (id) do update set nome = excluded.nome, papel = excluded.papel;

insert into public.perfis (id, nome, papel)
select id, 'Banho e Tosa', 'banho_tosa'  from auth.users where email = 'banhoetosa@exemplo.com'
on conflict (id) do update set nome = excluded.nome, papel = excluded.papel;

-- Conferência: deve listar os 3 usuários com seus papéis
select p.nome, p.papel, u.email
from public.perfis p join auth.users u on u.id = p.id
order by p.papel;
