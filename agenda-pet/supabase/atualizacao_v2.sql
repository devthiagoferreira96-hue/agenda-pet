-- =====================================================================
-- AGENDA PET – Atualização v2 (segurança, histórico, serviços, cancelamento)
-- Rode no Supabase: SQL Editor > New query > Run. (Pode rodar de novo sem problema.)
-- Precisa ter rodado antes: atualizacao_entregue.sql, atualizacao_leva_traz.sql
-- e atualizacao_entrega_outro_endereco.sql. Não apaga nada.
--
-- O que faz:
--  • limita nomes a 120 letras, textos a 500, telefone só números e CEP com 8 dígitos
--  • cria o histórico de alterações (só o administrador vê)
--  • acrescenta Serviço + Valor e Motivo do cancelamento
--  • trava o aviso ao tutor contra disparos repetidos
-- =====================================================================
-- ---------------------------------------------------------------------
-- Serviços, motivo do cancelamento (seguro rodar em banco já existente)
-- ---------------------------------------------------------------------
alter table public.agendamentos add column if not exists servico             text;
alter table public.agendamentos add column if not exists servico_valor       numeric(8,2);
alter table public.agendamentos add column if not exists motivo_cancelamento text;
alter table public.agendamentos add column if not exists cancelado_em        timestamptz;
alter table public.agendamentos add column if not exists cancelado_por       uuid references auth.users(id) on delete set null;

-- ---------------------------------------------------------------------
-- Limites de tamanho e formato (nomes até 120 letras, textos até 500,
-- telefone só números, CEP com 8 dígitos). "not valid" = não trava por
-- causa de registros antigos; vale para tudo que for criado ou alterado.
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select * from (values
    ('lim_tutor_nome',     'length(tutor_nome) <= 120'),
    ('lim_pet_nome',       'length(pet_nome) <= 120'),
    ('lim_raca',           'raca is null or length(raca) <= 120'),
    ('lim_pet_idade',      'pet_idade is null or length(pet_idade) <= 20'),
    ('lim_saude_obs',      'saude_obs is null or length(saude_obs) <= 500'),
    ('lim_observacoes',    'observacoes is null or length(observacoes) <= 500'),
    ('lim_telefone',       'telefone is null or telefone ~ ''^[0-9]{10,13}$'''),
    ('lim_end_cep',        'end_cep is null or end_cep ~ ''^[0-9]{8}$'''),
    ('lim_ent_cep',        'ent_cep is null or ent_cep ~ ''^[0-9]{8}$'''),
    ('lim_end_rua',        'end_rua is null or length(end_rua) <= 120'),
    ('lim_ent_rua',        'ent_rua is null or length(ent_rua) <= 120'),
    ('lim_end_numero',     'end_numero is null or length(end_numero) <= 20'),
    ('lim_ent_numero',     'ent_numero is null or length(ent_numero) <= 20'),
    ('lim_end_bairro',     'end_bairro is null or length(end_bairro) <= 120'),
    ('lim_ent_bairro',     'ent_bairro is null or length(ent_bairro) <= 120'),
    ('lim_end_cidade',     'end_cidade is null or length(end_cidade) <= 120'),
    ('lim_ent_cidade',     'ent_cidade is null or length(ent_cidade) <= 120'),
    ('lim_end_referencia', 'end_referencia is null or length(end_referencia) <= 500'),
    ('lim_ent_referencia', 'ent_referencia is null or length(ent_referencia) <= 500'),
    ('lim_servico',        'servico is null or length(servico) <= 120'),
    ('lim_servico_valor',  'servico_valor is null or (servico_valor >= 0 and servico_valor <= 99999)'),
    ('lim_motivo_cancel',  'motivo_cancelamento is null or length(motivo_cancelamento) <= 500')
  ) as t(nome, regra) loop
    execute format('alter table public.agendamentos drop constraint if exists %I', r.nome);
    execute format('alter table public.agendamentos add constraint %I check (%s) not valid', r.nome, r.regra);
  end loop;
end $$;

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

-- ---------------------------------------------------------------------
-- Histórico de alterações (só o administrador vê)
-- Grava sozinho: criação, alterações (campo: antes -> depois), finalização,
-- entrega, cancelamento, reativação, aviso ao tutor e exclusão.
-- ---------------------------------------------------------------------
create table if not exists public.historico (
  id              bigserial primary key,
  em              timestamptz not null default now(),
  agendamento_id  uuid,                       -- sem vínculo: o histórico fica mesmo se o agendamento for excluído
  acao            text not null,
  usuario_id      uuid,
  usuario_nome    text,
  usuario_papel   text,
  pet_nome        text,
  tutor_nome      text,
  data_agendada   date,
  horario         time(0),
  mudancas        jsonb                       -- { "campo": { "de": ..., "para": ... } }
);
create index if not exists historico_em_idx on public.historico (em desc);
create index if not exists historico_agend_idx on public.historico (agendamento_id);

alter table public.historico enable row level security;
drop policy if exists historico_admin_ver on public.historico;
create policy historico_admin_ver on public.historico
  for select to authenticated
  using (public.meu_papel() = 'admin');
-- ninguém grava, altera ou apaga o histórico pelo sistema: só o gatilho abaixo
revoke insert, update, delete on public.historico from anon, authenticated;

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
  ignorar text[] := array['id','criado_em','criado_por','origem','finalizado_em','finalizado_por',
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

drop trigger if exists trg_agendamento_historico on public.agendamentos;
create trigger trg_agendamento_historico
  after insert or update or delete on public.agendamentos
  for each row execute function public.registrar_historico();

-- ---------------------------------------------------------------------
-- Conferência: agendamentos ANTIGOS fora dos novos limites.
-- Se aparecer algum número maior que 0, me avise (esses registros
-- precisam de um ajuste antes de serem editados).
-- ---------------------------------------------------------------------
select
  count(*) filter (where telefone is not null and telefone !~ '^[0-9]{10,13}$')        as telefone_fora_do_padrao,
  count(*) filter (where (end_cep is not null and end_cep !~ '^[0-9]{8}$')
                      or (ent_cep is not null and ent_cep !~ '^[0-9]{8}$'))              as cep_fora_do_padrao,
  count(*) filter (where length(tutor_nome) > 120 or length(pet_nome) > 120
                      or length(coalesce(raca, '')) > 120)                               as nome_muito_longo,
  count(*) filter (where length(coalesce(saude_obs, '')) > 500
                      or length(coalesce(observacoes, '')) > 500)                        as texto_muito_longo
from public.agendamentos;
