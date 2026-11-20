-- =====================================================================
-- AGENDA PET – Atualização: etapa "Entregue" (pet retirado pelo tutor)
-- Rode no Supabase: SQL Editor > New query > Run. (Pode rodar de novo sem problema.)
-- Não apaga nada: só acrescenta a etapa nova e as colunas de horário da entrega.
--   agendado  -> finalizado (banho pronto) -> entregue (saiu da loja)
-- =====================================================================
-- Etapa "Entregue" (pet retirado pelo tutor) – seguro rodar em banco já existente
alter table public.agendamentos add column if not exists entregue_em timestamptz;
alter table public.agendamentos add column if not exists entregue_por uuid references auth.users(id) on delete set null;
alter table public.agendamentos drop constraint if exists agendamentos_status_check;
alter table public.agendamentos add constraint agendamentos_status_check
  check (status in ('agendado', 'finalizado', 'entregue', 'cancelado'));

create or replace function public.agendamento_antes_inserir()
returns trigger language plpgsql security definer set search_path = public
as $$
declare p public.papel_usuario;
begin
  p := public.meu_papel();
  if p is null then
    raise exception 'Usuário sem perfil cadastrado' using errcode = '42501';
  end if;
  if new.data < public.hoje_brasil() then
    raise exception 'Não é possível agendar em uma data que já passou' using errcode = 'P0001';
  end if;
  if new.data > date '2100-12-31' then
    raise exception 'A data máxima para agendamento é 31/12/2100' using errcode = 'P0001';
  end if;
  new.origem           := p;
  new.criado_por       := auth.uid();
  new.criado_em        := now();
  new.status           := 'agendado';
  new.finalizado_em    := null;
  new.finalizado_por   := null;
  new.entregue_em      := null;
  new.entregue_por     := null;
  new.aviso_enviado_em := null;
  return new;
end $$;

create or replace function public.agendamento_antes_alterar()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  -- remarcar para uma data que já passou não é permitido
  if new.data <> old.data and new.data < public.hoje_brasil() then
    raise exception 'Não é possível agendar em uma data que já passou' using errcode = 'P0001';
  end if;
  if new.data > date '2100-12-31' then
    raise exception 'A data máxima para agendamento é 31/12/2100' using errcode = 'P0001';
  end if;
  -- campos de controle não podem ser trocados
  new.origem     := old.origem;
  new.criado_por := old.criado_por;
  new.criado_em  := old.criado_em;

  -- banho terminado: "finalizado" e "entregue" guardam a hora em que o banho acabou
  if new.status in ('finalizado', 'entregue') then
    if old.status in ('finalizado', 'entregue') and old.finalizado_em is not null then
      new.finalizado_em  := old.finalizado_em;
      new.finalizado_por := old.finalizado_por;
    else
      new.finalizado_em  := now();
      new.finalizado_por := auth.uid();
    end if;
  else
    new.finalizado_em  := null;
    new.finalizado_por := null;
  end if;

  -- pet retirado pelo tutor
  if new.status = 'entregue' then
    if old.status = 'entregue' then
      new.entregue_em  := old.entregue_em;
      new.entregue_por := old.entregue_por;
    else
      new.entregue_em  := now();
      new.entregue_por := auth.uid();
    end if;
  else
    new.entregue_em  := null;
    new.entregue_por := null;
  end if;
  return new;
end $$;
