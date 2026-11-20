-- =====================================================================
-- AGENDA PET – Atualização v3 (desempenho dos gráficos)
-- Rode no Supabase: SQL Editor > New query > Run. (Pode rodar de novo sem problema.)
-- Não apaga nada. Faz os gráficos abrirem rápido mesmo com anos de dados
-- e deixa todas as consultas mais leves (regras de acesso otimizadas).
-- Precisa ter rodado antes o atualizacao_v2.sql.
-- (Se não rodar, os gráficos continuam funcionando do jeito antigo, só mais devagar.)
-- =====================================================================
-- ---------------------------------------------------------------------
-- Gráficos: contagem feita no banco (devolve só os totais, não os registros)
-- Respeita as mesmas regras de acesso (só quem tem perfil enxerga).
-- ---------------------------------------------------------------------
create or replace function public.contagem_entradas(p_inicio date, p_fim date, p_agrupar text)
returns table (chave text, origem text, registrados bigint, finalizados bigint)
language sql stable set search_path = public
as $$
  select case p_agrupar when 'ano' then to_char(a.data, 'YYYY')
                        when 'mes' then to_char(a.data, 'MM')
                        else to_char(a.data, 'DD') end   as chave,
         a.origem::text                                  as origem,
         count(*)                                        as registrados,
         count(*) filter (where a.status in ('finalizado', 'entregue')) as finalizados
  from public.agendamentos a
  where a.data between p_inicio and p_fim and a.status <> 'cancelado'
  group by 1, 2
  order by 1, 2
$$;
grant execute on function public.contagem_entradas(date, date, text) to authenticated;

-- ---------------------------------------------------------------------
-- Regras de acesso mais rápidas: confere o perfil 1 vez por consulta
-- (e não 1 vez por linha). Mesmas permissões de antes.
-- ---------------------------------------------------------------------
drop policy if exists agend_ver on public.agendamentos;
create policy agend_ver on public.agendamentos
  for select to authenticated
  using ((select public.meu_papel()) is not null);

drop policy if exists agend_criar on public.agendamentos;
create policy agend_criar on public.agendamentos
  for insert to authenticated
  with check ((select public.meu_papel()) is not null);

drop policy if exists agend_alterar on public.agendamentos;
create policy agend_alterar on public.agendamentos
  for update to authenticated
  using ((select public.meu_papel()) is not null)
  with check ((select public.meu_papel()) is not null);

drop policy if exists agend_excluir on public.agendamentos;
create policy agend_excluir on public.agendamentos
  for delete to authenticated
  using ((select public.meu_papel()) = 'admin');

drop policy if exists historico_admin_ver on public.historico;
create policy historico_admin_ver on public.historico
  for select to authenticated
  using ((select public.meu_papel()) = 'admin');
