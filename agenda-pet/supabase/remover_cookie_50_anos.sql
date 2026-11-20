-- =====================================================================
-- AGENDA PET – Remove o agendamento de teste da "Cookie" com idade impossível
-- (50 anos). Rode ANTES da atualização v5. Pode rodar de novo sem problema.
-- Supabase: SQL Editor > New query > cole tudo > Run.
-- =====================================================================

-- Remove só a Cookie com mais de 35 anos (a remoção fica no Histórico de alterações)
delete from public.agendamentos
where lower(trim(pet_nome)) = 'cookie'
  and pet_idade !~* 'm[eê]s|meses'
  and coalesce((regexp_match(pet_idade, '(\d{1,3})'))[1]::int, 0) > 35
returning data, horario, pet_nome, tutor_nome, pet_idade as removido;
