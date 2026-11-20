-- =====================================================================
-- AGENDA PET – Apaga TODOS os agendamentos E o histórico de alterações
-- (não tem como desfazer!)
-- Antes, faça o backup: aba Histórico > "Exportar planilha" (período: tudo)
-- e "Exportar histórico".
-- Continuam: usuários da equipe, tutores e pets.
-- Supabase: SQL Editor > New query > cole tudo > Run
-- (se aparecer o aviso de "destructive operation", confirme).
-- =====================================================================

-- o histórico não registra uma linha de "excluído" para cada agendamento apagado
alter table public.agendamentos disable trigger trg_agendamento_historico;

delete from public.agendamentos;

alter table public.agendamentos enable trigger trg_agendamento_historico;

-- histórico de alterações (a numeração recomeça do 1)
truncate table public.historico restart identity;

-- conferência: as duas devem mostrar 0
select (select count(*) from public.agendamentos) as agendamentos_restantes,
       (select count(*) from public.historico)    as historico_restante;
