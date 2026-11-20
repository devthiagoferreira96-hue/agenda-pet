-- =====================================================================
-- AGENDA PET – Atualização: "Entregar em outro endereço"
-- (buscar o pet num lugar e entregar em outro)
-- Rode no Supabase: SQL Editor > New query > Run. (Pode rodar de novo sem problema.)
-- Precisa ter rodado antes o atualizacao_leva_traz.sql.
-- Não apaga nada.
-- =====================================================================
-- Entrega em outro endereço (diferente do local de busca) – seguro rodar em banco já existente
alter table public.agendamentos add column if not exists entrega_outro_end boolean not null default false;
alter table public.agendamentos add column if not exists ent_cep        text;
alter table public.agendamentos add column if not exists ent_rua        text;
alter table public.agendamentos add column if not exists ent_numero     text;
alter table public.agendamentos add column if not exists ent_bairro     text;
alter table public.agendamentos add column if not exists ent_cidade     text;
alter table public.agendamentos add column if not exists ent_referencia text;
-- com endereço de entrega separado, rua e número dele são obrigatórios
alter table public.agendamentos drop constraint if exists agendamentos_endereco_entrega_check;
alter table public.agendamentos add constraint agendamentos_endereco_entrega_check check (
  not entrega_outro_end
  or (length(trim(coalesce(ent_rua, ''))) > 0 and length(trim(coalesce(ent_numero, ''))) > 0)
);
