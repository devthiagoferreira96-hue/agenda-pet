-- =====================================================================
-- AGENDA PET – Atualização v4: etapa "Em banho"
-- Rode no Supabase: SQL Editor > New query > Run. (Pode rodar de novo sem problema.)
-- Precisa ter rodado antes o atualizacao_v2.sql (e o v3). Não apaga nada.
--   agendado -> em banho -> finalizado -> entregue
-- =====================================================================
-- Etapa "Em banho" (seguro rodar em banco já existente)
alter table public.agendamentos add column if not exists iniciado_em timestamptz;
alter table public.agendamentos drop constraint if exists agendamentos_status_check;
alter table public.agendamentos add constraint agendamentos_status_check
  check (status in ('agendado', 'em_banho', 'finalizado', 'entregue', 'cancelado'));

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
  new.iniciado_em      := null;
  new.finalizado_em    := null;
  new.finalizado_por   := null;
  new.entregue_em      := null;
  new.entregue_por     := null;
  new.aviso_enviado_em := null;
  new.cancelado_em     := null;
  new.cancelado_por    := null;
  new.motivo_cancelamento := null;
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

  -- banho iniciado: guarda a hora em que o pet entrou no banho
  if new.status = 'em_banho' and old.status is distinct from 'em_banho' then
    new.iniciado_em := now();
  elsif new.status = 'agendado' then
    new.iniciado_em := null;                     -- voltou para agendado
  else
    new.iniciado_em := old.iniciado_em;          -- finalizado/entregue mantém a hora de início
  end if;

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

  -- cancelamento: guarda quando e quem; ao reativar, limpa o motivo
  if new.status = 'cancelado' then
    if old.status = 'cancelado' then
      new.cancelado_em  := old.cancelado_em;
      new.cancelado_por := old.cancelado_por;
    else
      new.cancelado_em  := now();
      new.cancelado_por := auth.uid();
    end if;
  else
    new.cancelado_em  := null;
    new.cancelado_por := null;
    new.motivo_cancelamento := null;
  end if;

  -- aviso ao tutor: a hora do último aviso só anda para frente (ninguém "zera" para reenviar)
  if old.aviso_enviado_em is not null
     and (new.aviso_enviado_em is null or new.aviso_enviado_em < old.aviso_enviado_em) then
    new.aviso_enviado_em := old.aviso_enviado_em;
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

create or replace function public.registrar_historico()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  v_acao text;
  v_mud  jsonb := '{}'::jsonb;
  v_reg  public.agendamentos;
  v_nome text;
  v_papel text;
  k text;
  ignorar text[] := array['id','criado_em','criado_por','origem','iniciado_em','finalizado_em','finalizado_por',
                          'entregue_em','entregue_por','cancelado_em','cancelado_por','aviso_enviado_em','status'];
begin
  select nome, papel::text into v_nome, v_papel from public.perfis where id = auth.uid();

  if tg_op = 'INSERT' then
    v_acao := 'criado'; v_reg := new;
  elsif tg_op = 'DELETE' then
    v_acao := 'excluido'; v_reg := old;
  else
    v_reg := new;
    -- campos que mudaram (antes -> depois)
    for k in select jsonb_object_keys(to_jsonb(new)) loop
      if not (k = any(ignorar)) and (to_jsonb(new) -> k) is distinct from (to_jsonb(old) -> k) then
        v_mud := v_mud || jsonb_build_object(k, jsonb_build_object('de', to_jsonb(old) -> k, 'para', to_jsonb(new) -> k));
      end if;
    end loop;

    if new.status is distinct from old.status then
      v_acao := case
        when new.status = 'em_banho'   then 'banho iniciado'
        when new.status = 'finalizado' and old.status = 'entregue' then 'entrega desfeita'
        when new.status = 'finalizado' then 'finalizado'
        when new.status = 'entregue'   then 'entregue'
        when new.status = 'cancelado'  then 'cancelado'
        when old.status = 'cancelado'  then 'reativado'
        else 'reaberto' end;
    elsif v_mud <> '{}'::jsonb then
      v_acao := 'alterado';
    elsif new.aviso_enviado_em is distinct from old.aviso_enviado_em then
      v_acao := 'tutor avisado';
    else
      return null;                               -- nada relevante mudou
    end if;
  end if;

  insert into public.historico (agendamento_id, acao, usuario_id, usuario_nome, usuario_papel,
                                pet_nome, tutor_nome, data_agendada, horario, mudancas)
  values (v_reg.id, v_acao, auth.uid(), v_nome, v_papel,
          v_reg.pet_nome, v_reg.tutor_nome, v_reg.data, v_reg.horario,
          case when v_mud = '{}'::jsonb then null else v_mud end);
  return null;
end $$;
