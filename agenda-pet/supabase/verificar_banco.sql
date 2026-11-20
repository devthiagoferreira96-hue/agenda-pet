-- =====================================================================
-- AGENDA PET – Conferência do banco (só LÊ, não muda nada)
-- Rode no Supabase: SQL Editor > New query > Run.
-- Todas as linhas devem aparecer com "OK". Se alguma aparecer "FALTA",
-- rode o supabase/schema.sql inteiro (ele completa o que faltar, sem apagar nada)
-- e rode esta conferência de novo.
-- =====================================================================
with c(item, ok) as (values
  ('Etapa Entregue',                    exists (select 1 from information_schema.columns where table_schema='public' and table_name='agendamentos' and column_name='entregue_em')),
  ('Leva e traz (endereço)',            exists (select 1 from information_schema.columns where table_schema='public' and table_name='agendamentos' and column_name='end_rua')),
  ('Entrega em outro endereço',         exists (select 1 from information_schema.columns where table_schema='public' and table_name='agendamentos' and column_name='ent_rua')),
  ('Serviço e valor (v2)',              exists (select 1 from information_schema.columns where table_schema='public' and table_name='agendamentos' and column_name='servico_valor')),
  ('Motivo do cancelamento (v2)',       exists (select 1 from information_schema.columns where table_schema='public' and table_name='agendamentos' and column_name='motivo_cancelamento')),
  ('Limites de tamanho/telefone (v2)',  exists (select 1 from pg_constraint where conname = 'lim_telefone')),
  ('Histórico de alterações (v2)',      to_regclass('public.historico') is not null),
  ('Gatilho do histórico (v2)',         exists (select 1 from pg_trigger where tgname = 'trg_agendamento_historico')),
  ('Gráficos rápidos (v3)',             to_regproc('public.contagem_entradas') is not null),
  ('Regras de acesso otimizadas (v3)',  exists (select 1 from pg_policies where policyname = 'agend_ver' and qual like '%SELECT%meu_papel%')),
  ('Etapa Em banho no status (v4)',     exists (select 1 from pg_constraint where conname = 'agendamentos_status_check' and pg_get_constraintdef(oid) like '%em_banho%')),
  ('Hora do início do banho (v4)',      pg_get_functiondef('public.agendamento_antes_alterar'::regproc) like '%iniciado_em := now()%'),
  ('Histórico "Banho iniciado" (v4)',   pg_get_functiondef('public.registrar_historico'::regproc) like '%banho iniciado%'),
  ('Trava do aviso WhatsApp (v2)',      pg_get_functiondef('public.agendamento_antes_alterar'::regproc) like '%aviso_enviado_em < old.aviso_enviado_em%'),
  ('Tutores e pets (v5)',               to_regclass('public.tutores') is not null and to_regclass('public.pets') is not null),
  ('Agendamento ligado ao pet (v5)',    exists (select 1 from pg_trigger where tgname = 'trg_agendamento_cliente')),
  ('Busca de clientes (v5)',            to_regproc('public.buscar_clientes') is not null),
  ('Tutor só vê os próprios dados (v5)',exists (select 1 from pg_policies where policyname = 'pets_proprio_ver'))
)
select item, case when ok then 'OK' else 'FALTA' end as situacao from c;
