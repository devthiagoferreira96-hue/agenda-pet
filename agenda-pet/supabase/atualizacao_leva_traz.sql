-- =====================================================================
-- AGENDA PET – Atualização: "Leva e traz" (buscar e/ou entregar o pet em casa)
-- Rode no Supabase: SQL Editor > New query > Run. (Pode rodar de novo sem problema.)
-- Não apaga nada: só acrescenta as opções de busca/entrega e o endereço.
-- =====================================================================
-- Leva e traz (busca/entrega do pet em casa) – seguro rodar em banco já existente
alter table public.agendamentos add column if not exists busca_domicilio   boolean not null default false;
alter table public.agendamentos add column if not exists entrega_domicilio boolean not null default false;
alter table public.agendamentos add column if not exists end_cep        text;
alter table public.agendamentos add column if not exists end_rua        text;
alter table public.agendamentos add column if not exists end_numero     text;
alter table public.agendamentos add column if not exists end_bairro     text;
alter table public.agendamentos add column if not exists end_cidade     text;
alter table public.agendamentos add column if not exists end_referencia text;
-- com busca ou entrega, rua e número são obrigatórios
alter table public.agendamentos drop constraint if exists agendamentos_endereco_check;
alter table public.agendamentos add constraint agendamentos_endereco_check check (
  not (busca_domicilio or entrega_domicilio)
  or (length(trim(coalesce(end_rua, ''))) > 0 and length(trim(coalesce(end_numero, ''))) > 0)
);
