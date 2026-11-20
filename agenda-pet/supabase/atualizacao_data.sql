-- =====================================================================
-- AGENDA PET – Atualização: datas permitidas (de hoje até 31/12/2100)
-- Rode no Supabase: SQL Editor > New query > Run. (Pode rodar de novo sem problema.)
-- Não apaga nada. Agendamentos antigos continuam podendo ser finalizados,
-- cancelados e editados; só não dá para criar ou remarcar para antes de hoje.
-- =====================================================================

-- Data de hoje no horário de Brasília (o servidor do Supabase usa UTC)
create or replace function public.hoje_brasil()
returns date language sql stable
as $$ select (now() at time zone 'America/Sao_Paulo')::date $$;

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

  if new.status = 'finalizado' and old.status <> 'finalizado' then
    new.finalizado_em  := now();
    new.finalizado_por := auth.uid();
  elsif new.status <> 'finalizado' then
    new.finalizado_em  := null;
    new.finalizado_por := null;
  else
    new.finalizado_em  := old.finalizado_em;
    new.finalizado_por := old.finalizado_por;
  end if;
  return new;
end $$;
