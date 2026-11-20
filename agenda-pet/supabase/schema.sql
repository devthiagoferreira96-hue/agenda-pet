-- =====================================================================
-- AGENDA PET – Banco de dados (Supabase / PostgreSQL)
-- Rode este arquivo inteiro no Supabase: SQL Editor > New query > Run.
-- Pode rodar de novo sem problema (é idempotente).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. Papéis de usuário: admin (você), petshop (Cliente 1), banho_tosa (Cliente 2)
-- ---------------------------------------------------------------------
do $$ begin
  create type public.papel_usuario as enum ('admin', 'petshop', 'banho_tosa');
exception when duplicate_object then null; end $$;
-- papel de testes (cadastros dele ficam separados nos gráficos)
alter type public.papel_usuario add value if not exists 'teste';

create table if not exists public.perfis (
  id         uuid primary key references auth.users(id) on delete cascade,
  nome       text not null,
  papel      public.papel_usuario not null,
  criado_em  timestamptz not null default now()
);

-- Papel do usuário logado (usado nas regras de acesso)
create or replace function public.meu_papel()
returns public.papel_usuario
language sql stable security definer set search_path = public
as $$ select papel from public.perfis where id = auth.uid() $$;

-- ---------------------------------------------------------------------
-- 2. Agendamentos
-- ---------------------------------------------------------------------
create table if not exists public.agendamentos (
  id               uuid primary key default gen_random_uuid(),
  data             date not null,                       -- obrigatória
  horario          time(0) not null,                    -- obrigatório
  tutor_nome       text not null check (length(trim(tutor_nome)) > 0),
  telefone         text,                                -- só números, ex.: 11999999999
  pet_nome         text not null check (length(trim(pet_nome)) > 0),
  pet_idade        text,
  pet_sexo         text check (pet_sexo in ('Macho', 'Fêmea')),
  saude_obs        text,                                -- alergias / problemas de saúde
  porte            text check (porte in ('Pequeno', 'Médio', 'Grande')),
  peso_kg          numeric(5,2) check (peso_kg is null or peso_kg > 0),
  raca             text,
  pelagem          text check (pelagem in ('Curto', 'Longo')),
  observacoes      text,
  status           text not null default 'agendado'
                   check (status in ('agendado', 'finalizado', 'entregue', 'cancelado')),
  origem           public.papel_usuario not null,       -- quem cadastrou (preenchido pelo banco)
  criado_por       uuid references auth.users(id) on delete set null,
  criado_em        timestamptz not null default now(),
  finalizado_em    timestamptz,
  finalizado_por   uuid references auth.users(id) on delete set null,
  entregue_em      timestamptz,                          -- quando o pet foi retirado pelo tutor
  entregue_por     uuid references auth.users(id) on delete set null,
  aviso_enviado_em timestamptz
);

-- A TRAVA: um único animal por data + horário (cancelados não contam).
-- Se dois computadores salvarem o mesmo horário ao mesmo tempo, o banco
-- aceita o primeiro e recusa o segundo com o erro 23505.
create unique index if not exists agendamentos_horario_unico
  on public.agendamentos (data, horario)
  where status <> 'cancelado';

create index if not exists agendamentos_data_idx on public.agendamentos (data);

-- Espécie do animal (adicionada depois; seguro rodar em banco já existente)
alter table public.agendamentos add column if not exists especie text;
do $$ begin
  alter table public.agendamentos
    add constraint agendamentos_especie_check check (especie in ('Canino', 'Felino'));
exception when duplicate_object then null; end $$;


-- Etapa "Entregue" (pet retirado pelo tutor) – seguro rodar em banco já existente
alter table public.agendamentos add column if not exists entregue_em timestamptz;
alter table public.agendamentos add column if not exists entregue_por uuid references auth.users(id) on delete set null;
alter table public.agendamentos drop constraint if exists agendamentos_status_check;
alter table public.agendamentos add constraint agendamentos_status_check
  check (status in ('agendado', 'finalizado', 'entregue', 'cancelado'));

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

-- Etapa "Em banho" (seguro rodar em banco já existente)
alter table public.agendamentos add column if not exists iniciado_em timestamptz;
alter table public.agendamentos drop constraint if exists agendamentos_status_check;
alter table public.agendamentos add constraint agendamentos_status_check
  check (status in ('agendado', 'em_banho', 'finalizado', 'entregue', 'cancelado'));

-- ---------------------------------------------------------------------
-- 3. Regras automáticas (ninguém consegue falsificar origem/datas pelo sistema)
-- ---------------------------------------------------------------------
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

drop trigger if exists trg_agendamento_inserir on public.agendamentos;
create trigger trg_agendamento_inserir
  before insert on public.agendamentos
  for each row execute function public.agendamento_antes_inserir();

drop trigger if exists trg_agendamento_alterar on public.agendamentos;
create trigger trg_agendamento_alterar
  before update on public.agendamentos
  for each row execute function public.agendamento_antes_alterar();

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
  using ((select public.meu_papel()) = 'admin');
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

drop trigger if exists trg_agendamento_historico on public.agendamentos;
create trigger trg_agendamento_historico
  after insert or update or delete on public.agendamentos
  for each row execute function public.registrar_historico();

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
-- 4. Permissões (Row Level Security)
--    - Os 3 usuários veem e criam agendamentos.
--    - Os 3 podem editar, finalizar e cancelar.
--    - Só o administrador exclui de vez.
--    - Perfis só são criados/alterados pelo administrador no painel do Supabase.
-- ---------------------------------------------------------------------
alter table public.perfis        enable row level security;
alter table public.agendamentos  enable row level security;

drop policy if exists perfis_ver on public.perfis;
create policy perfis_ver on public.perfis
  for select to authenticated
  using ((select public.meu_papel()) is not null);

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

-- ---------------------------------------------------------------------
-- 5. Tempo real: as telas atualizam sozinhas quando o outro computador agenda
-- ---------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.agendamentos;
exception when duplicate_object then null; when undefined_object then null; end $$;

-- =====================================================================
-- Cadastro de clientes (tutores e pets) – v5
-- =====================================================================
-- ---------------------------------------------------------------------
-- Funções de apoio
-- ---------------------------------------------------------------------
-- Telefone só com números, sem o 55 do Brasil: "(15) 99887-6655" -> "15998876655"
create or replace function public.normalizar_tel(t text)
returns text language sql immutable
as $$
  select case
    when d is null or length(d) < 10 then null
    when length(d) in (12, 13) and d like '55%' then substr(d, 3)
    when length(d) in (10, 11) then d
    else null end
  from (select nullif(regexp_replace(coalesce(t, ''), '\D', '', 'g'), '') as d) x
$$;

-- "3 anos" / "8 meses" / "1 ano" / "1 mês" -> data de nascimento aproximada
-- Idade irreal (mais de 35 anos ou de 420 meses, provável erro de digitação) fica sem data.
create or replace function public.idade_para_nascimento(txt text)
returns date language sql stable
as $$
  select case
    when m is null then null
    when txt ~* 'm[eê]s|meses' then
      case when m[1]::int <= 420 then (public.hoje_brasil() - make_interval(months => m[1]::int))::date end
    else
      case when m[1]::int <= 35 then (public.hoje_brasil() - make_interval(years => m[1]::int))::date end
    end
  from (select regexp_match(coalesce(txt, ''), '(\d{1,3})') as m) x
$$;

-- Sem acento e minúsculo, para a busca achar "Joao" e "João"
create or replace function public.sem_acento(t text)
returns text language sql immutable
as $$ select translate(lower(coalesce(t, '')), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn') $$;

-- É a equipe da loja? (tem perfil de funcionário)
create or replace function public.eh_equipe()
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.perfis where id = auth.uid()) $$;

-- ---------------------------------------------------------------------
-- 1. Tabelas
-- ---------------------------------------------------------------------
create table if not exists public.tutores (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid unique references auth.users(id) on delete set null,  -- conta da área do tutor
  nome            text not null check (length(trim(nome)) between 1 and 120),
  telefone        text not null unique check (telefone ~ '^[0-9]{10,11}$'),
  end_cep         text check (end_cep is null or end_cep ~ '^[0-9]{8}$'),
  end_rua         text check (end_rua is null or length(end_rua) <= 120),
  end_numero      text check (end_numero is null or length(end_numero) <= 20),
  end_bairro      text check (end_bairro is null or length(end_bairro) <= 120),
  end_cidade      text check (end_cidade is null or length(end_cidade) <= 120),
  end_referencia  text check (end_referencia is null or length(end_referencia) <= 500),
  origem          text not null default 'loja' check (origem in ('loja', 'tutor')),
  conferido       boolean not null default true,      -- false = cadastro/alteração feita pelo tutor, a loja ainda não conferiu
  lgpd_aceite_em  timestamptz,
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now()
);

create table if not exists public.pets (
  id              uuid primary key default gen_random_uuid(),
  tutor_id        uuid not null references public.tutores(id) on delete cascade,
  nome            text not null check (length(trim(nome)) between 1 and 120),
  especie         text check (especie in ('Canino', 'Felino')),
  sexo            text check (sexo in ('Macho', 'Fêmea')),
  nascimento      date check (nascimento is null or nascimento > date '1980-01-01'),
  porte           text check (porte in ('Pequeno', 'Médio', 'Grande')),
  raca            text check (raca is null or length(raca) <= 120),
  pelagem         text check (pelagem in ('Curto', 'Longo')),
  peso_kg         numeric(5,2) check (peso_kg is null or (peso_kg > 0 and peso_kg < 999)),
  tem_saude       boolean,                           -- alergias ou problemas de saúde? (null = não informado)
  saude_obs       text check (saude_obs is null or length(saude_obs) <= 500),
  observacoes     text check (observacoes is null or length(observacoes) <= 500),
  ativo           boolean not null default true,     -- false = removido da lista (o histórico continua)
  conferido       boolean not null default true,
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now()
);
create index if not exists pets_tutor_idx on public.pets (tutor_id);
-- nascimento: só datas possíveis para um pet (de 1980 até hoje)
alter table public.pets drop constraint if exists pets_nascimento_check;
alter table public.pets add constraint pets_nascimento_check
  check (nascimento is null or (nascimento > date '1980-01-01' and nascimento <= current_date + 1));

-- agendamento ligado ao tutor e ao pet (os dados do dia continuam guardados no agendamento)
alter table public.agendamentos add column if not exists tutor_id uuid references public.tutores(id) on delete set null;
alter table public.agendamentos add column if not exists pet_id   uuid references public.pets(id) on delete set null;
create index if not exists agendamentos_pet_idx   on public.agendamentos (pet_id);
create index if not exists agendamentos_tutor_idx on public.agendamentos (tutor_id);

-- idade no agendamento: no máximo 35 anos (ou 420 meses). Vale ao digitar/alterar a idade;
-- agendamentos antigos continuam podendo mudar de etapa normalmente.
alter table public.agendamentos drop constraint if exists lim_pet_idade_max;
create or replace function public.idade_possivel(txt text)
returns boolean language sql immutable
as $$
  select txt is null
      or coalesce((regexp_match(txt, '(\d{1,3})'))[1]::int, 0) <= case when txt ~* 'm[eê]s|meses' then 420 else 35 end
$$;
create or replace function public.agendamento_conferir_idade()
returns trigger language plpgsql
as $$
begin
  if (tg_op = 'INSERT' or new.pet_idade is distinct from old.pet_idade) and not public.idade_possivel(new.pet_idade) then
    raise exception 'Idade inválida: um pet não pode ter mais de 35 anos.' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists trg_agendamento_idade on public.agendamentos;
create trigger trg_agendamento_idade before insert or update on public.agendamentos
  for each row execute function public.agendamento_conferir_idade();

-- ---------------------------------------------------------------------
-- 2. Proteções automáticas
-- ---------------------------------------------------------------------
-- Tutor: o próprio tutor não troca celular, conta nem marca como conferido.
-- Qualquer alteração feita por ele volta a aparecer para a loja conferir.
create or replace function public.tutor_antes_salvar()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  new.atualizado_em := now();
  if tg_op = 'UPDATE' then
    new.criado_em := old.criado_em;
    new.origem    := old.origem;
    if public.eh_equipe() then
      new.user_id := old.user_id;                       -- a conta só é ligada pelo sistema de cadastro
      if old.user_id is not null and new.telefone is distinct from old.telefone then
        raise exception 'Este tutor tem acesso pelo celular. Para trocar o celular, fale com o administrador.' using errcode = 'P0001';
      end if;
    elsif old.user_id is not null and old.user_id = auth.uid() then
      new.user_id        := old.user_id;
      new.telefone       := old.telefone;
      new.lgpd_aceite_em := old.lgpd_aceite_em;
      new.conferido      := false;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_tutor_salvar on public.tutores;
create trigger trg_tutor_salvar before insert or update on public.tutores
  for each row execute function public.tutor_antes_salvar();

create or replace function public.pet_antes_salvar()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  new.atualizado_em := now();
  -- idade possível: nenhum pet passa de 35 anos
  if new.nascimento is not null and new.nascimento < public.hoje_brasil() - interval '35 years' then
    raise exception 'Idade inválida: um pet não pode ter mais de 35 anos.' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    new.criado_em := old.criado_em;
    new.tutor_id  := old.tutor_id;                      -- pet não muda de dono
  end if;
  if not public.eh_equipe() and auth.uid() is not null then
    new.conferido := false;                             -- feito pelo tutor: a loja confere
  end if;
  return new;
end $$;
drop trigger if exists trg_pet_salvar on public.pets;
create trigger trg_pet_salvar before insert or update on public.pets
  for each row execute function public.pet_antes_salvar();

-- ---------------------------------------------------------------------
-- 3. Regras de acesso
-- ---------------------------------------------------------------------
alter table public.tutores enable row level security;
alter table public.pets    enable row level security;

drop policy if exists tutores_equipe_ver     on public.tutores;
drop policy if exists tutores_equipe_criar   on public.tutores;
drop policy if exists tutores_equipe_alterar on public.tutores;
drop policy if exists tutores_admin_excluir  on public.tutores;
drop policy if exists tutores_proprio_ver    on public.tutores;
drop policy if exists tutores_proprio_alterar on public.tutores;
create policy tutores_equipe_ver     on public.tutores for select to authenticated using ((select public.eh_equipe()));
create policy tutores_equipe_criar   on public.tutores for insert to authenticated with check ((select public.eh_equipe()));
create policy tutores_equipe_alterar on public.tutores for update to authenticated using ((select public.eh_equipe())) with check ((select public.eh_equipe()));
create policy tutores_admin_excluir  on public.tutores for delete to authenticated using ((select public.meu_papel()) = 'admin');
create policy tutores_proprio_ver    on public.tutores for select to authenticated using (user_id = (select auth.uid()));
create policy tutores_proprio_alterar on public.tutores for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists pets_equipe_ver     on public.pets;
drop policy if exists pets_equipe_criar   on public.pets;
drop policy if exists pets_equipe_alterar on public.pets;
drop policy if exists pets_admin_excluir  on public.pets;
drop policy if exists pets_proprio_ver    on public.pets;
drop policy if exists pets_proprio_criar  on public.pets;
drop policy if exists pets_proprio_alterar on public.pets;
create policy pets_equipe_ver     on public.pets for select to authenticated using ((select public.eh_equipe()));
create policy pets_equipe_criar   on public.pets for insert to authenticated with check ((select public.eh_equipe()));
create policy pets_equipe_alterar on public.pets for update to authenticated using ((select public.eh_equipe())) with check ((select public.eh_equipe()));
create policy pets_admin_excluir  on public.pets for delete to authenticated using ((select public.meu_papel()) = 'admin');
create policy pets_proprio_ver    on public.pets for select to authenticated
  using (tutor_id in (select id from public.tutores where user_id = (select auth.uid())));
create policy pets_proprio_criar  on public.pets for insert to authenticated
  with check (tutor_id in (select id from public.tutores where user_id = (select auth.uid())));
create policy pets_proprio_alterar on public.pets for update to authenticated
  using (tutor_id in (select id from public.tutores where user_id = (select auth.uid())))
  with check (tutor_id in (select id from public.tutores where user_id = (select auth.uid())));

-- visitante sem login não toca em nada
revoke all on public.tutores, public.pets from anon;

-- limite de pets por tutor na área do tutor (evita abuso)
create or replace function public.pet_limite_tutor()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if not public.eh_equipe() and (select count(*) from public.pets where tutor_id = new.tutor_id) >= 30 then
    raise exception 'Limite de pets atingido. Fale com a loja.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_pet_limite on public.pets;
create trigger trg_pet_limite before insert on public.pets
  for each row execute function public.pet_limite_tutor();

-- ---------------------------------------------------------------------
-- 4. Agendamento ligado ao tutor e ao pet (automático)
-- Com telefone: acha (ou cria) o tutor; acha o pet pelo nome (ou cria).
-- Os dados do pet ficam atualizados com o que a loja informou no agendamento.
-- ---------------------------------------------------------------------
create or replace function public.agendamento_vincular_cliente()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  tel text := public.normalizar_tel(new.telefone);
  t uuid; p uuid;
begin
  if tg_op = 'UPDATE' and
     (new.telefone, new.tutor_nome, new.pet_nome, new.pet_id, new.especie, new.pet_sexo, new.pet_idade, new.porte,
      new.peso_kg, new.raca, new.pelagem, new.saude_obs, new.observacoes, new.end_rua)
     is not distinct from
     (old.telefone, old.tutor_nome, old.pet_nome, old.pet_id, old.especie, old.pet_sexo, old.pet_idade, old.porte,
      old.peso_kg, old.raca, old.pelagem, old.saude_obs, old.observacoes, old.end_rua) then
    return new;                                         -- só mudou etapa/horário: nada a fazer
  end if;
  if tel is null then
    new.tutor_id := null; new.pet_id := null;
    return new;
  end if;

  select id into t from public.tutores where telefone = tel;
  if t is null then
    insert into public.tutores (nome, telefone, origem, conferido)
    values (left(trim(new.tutor_nome), 120), tel, 'loja', true)
    returning id into t;
  end if;
  -- endereço da busca vira o endereço do tutor quando ele ainda não tem
  if new.busca_domicilio and new.end_rua is not null then
    update public.tutores set end_cep = new.end_cep, end_rua = new.end_rua, end_numero = new.end_numero,
           end_bairro = new.end_bairro, end_cidade = new.end_cidade, end_referencia = new.end_referencia
     where id = t and end_rua is null;
  end if;
  new.tutor_id := t;

  if new.pet_id is not null then
    select id into p from public.pets where id = new.pet_id and tutor_id = t;
  end if;
  if p is null then
    select id into p from public.pets
     where tutor_id = t and lower(trim(nome)) = lower(trim(new.pet_nome))
     order by ativo desc, criado_em limit 1;
  end if;
  if p is null then
    insert into public.pets (tutor_id, nome, especie, sexo, nascimento, porte, raca, pelagem, peso_kg,
                             tem_saude, saude_obs, observacoes, conferido)
    values (t, left(trim(new.pet_nome), 120), new.especie, new.pet_sexo, public.idade_para_nascimento(new.pet_idade),
            new.porte, new.raca, new.pelagem, new.peso_kg,
            case when new.saude_obs is not null then true end, new.saude_obs, new.observacoes, true)
    returning id into p;
  else
    update public.pets set
      especie     = coalesce(new.especie, especie),
      sexo        = coalesce(new.pet_sexo, sexo),
      nascimento  = coalesce(nascimento, public.idade_para_nascimento(new.pet_idade)),
      porte       = coalesce(new.porte, porte),
      raca        = coalesce(new.raca, raca),
      pelagem     = coalesce(new.pelagem, pelagem),
      peso_kg     = coalesce(new.peso_kg, peso_kg),
      tem_saude   = case when new.saude_obs is not null then true else tem_saude end,
      saude_obs   = coalesce(new.saude_obs, saude_obs),
      observacoes = coalesce(new.observacoes, observacoes),
      ativo       = true
     where id = p;
  end if;
  new.pet_id := p;
  return new;
end $$;
drop trigger if exists trg_agendamento_cliente on public.agendamentos;
create trigger trg_agendamento_cliente before insert or update on public.agendamentos
  for each row execute function public.agendamento_vincular_cliente();

-- ---------------------------------------------------------------------
-- 5. Busca de clientes (celular, tutor ou pet) – usada no formulário da loja
-- Respeita as regras de acesso (security invoker).
-- ---------------------------------------------------------------------
create or replace function public.buscar_clientes(q text)
returns table (tutor_id uuid, tutor_nome text, telefone text, tutor_conferido boolean,
               end_cep text, end_rua text, end_numero text, end_bairro text, end_cidade text, end_referencia text,
               pet_id uuid, pet_nome text, especie text, sexo text, nascimento date, porte text, raca text,
               pelagem text, peso_kg numeric, tem_saude boolean, saude_obs text, observacoes text, pet_conferido boolean)
language sql stable set search_path = public
as $$
  with termo as (
    select public.sem_acento(trim(left(coalesce(q, ''), 60))) as txt,
           regexp_replace(coalesce(q, ''), '\D', '', 'g') as dig
  )
  select t.id, t.nome, t.telefone, t.conferido,
         t.end_cep, t.end_rua, t.end_numero, t.end_bairro, t.end_cidade, t.end_referencia,
         p.id, p.nome, p.especie, p.sexo, p.nascimento, p.porte, p.raca,
         p.pelagem, p.peso_kg, p.tem_saude, p.saude_obs, p.observacoes, p.conferido
  from public.tutores t
  left join public.pets p on p.tutor_id = t.id and p.ativo
  cross join termo
  where length(termo.txt) >= 2 and (
        (length(termo.dig) >= 4 and t.telefone like '%' || termo.dig || '%')
     or (length(termo.dig) < 4 and (public.sem_acento(t.nome) like '%' || termo.txt || '%'
                                     or public.sem_acento(p.nome) like '%' || termo.txt || '%')))
  order by (t.conferido and coalesce(p.conferido, true)), t.nome, p.nome
  limit 20
$$;

-- só quem entrou no sistema usa as funções novas
revoke execute on function public.buscar_clientes(text) from public, anon;
grant  execute on function public.buscar_clientes(text) to authenticated;
revoke execute on function public.eh_equipe() from public, anon;
grant  execute on function public.eh_equipe() to authenticated;

-- ---------------------------------------------------------------------
-- 6. Histórico: ligar tutor/pet não conta como "alteração"
-- ---------------------------------------------------------------------
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
                          'entregue_em','entregue_por','cancelado_em','cancelado_por','aviso_enviado_em','status',
                          'tutor_id','pet_id'];
begin
  select nome, papel::text into v_nome, v_papel from public.perfis where id = auth.uid();

  if tg_op = 'INSERT' then
    v_acao := 'criado'; v_reg := new;
  elsif tg_op = 'DELETE' then
    v_acao := 'excluido'; v_reg := old;
  else
    v_reg := new;
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
      return null;
    end if;
  end if;

  insert into public.historico (agendamento_id, acao, usuario_id, usuario_nome, usuario_papel,
                                pet_nome, tutor_nome, data_agendada, horario, mudancas)
  values (v_reg.id, v_acao, auth.uid(), v_nome, v_papel,
          v_reg.pet_nome, v_reg.tutor_nome, v_reg.data, v_reg.horario,
          case when v_mud = '{}'::jsonb then null else v_mud end);
  return null;
end $$;

-- ---------------------------------------------------------------------
-- Controle de criação de contas pela página do tutor (limite contra robôs).
-- Só a função do servidor mexe aqui; ninguém pelo site lê ou escreve.
-- ---------------------------------------------------------------------
create table if not exists public.tentativas_conta (
  ip  text not null,
  em  timestamptz not null default now()
);
create index if not exists tentativas_conta_idx on public.tentativas_conta (ip, em);
alter table public.tentativas_conta enable row level security;
revoke all on public.tentativas_conta from anon, authenticated;

-- ---------------------------------------------------------------------
-- 7. Importa os clientes dos agendamentos que já existem
-- (só os que têm telefone; roda de novo sem duplicar)
-- ---------------------------------------------------------------------
alter table public.agendamentos disable trigger trg_agendamento_historico;
alter table public.agendamentos disable trigger trg_agendamento_alterar;
alter table public.agendamentos disable trigger trg_agendamento_cliente;

-- tutores: um por telefone, com o nome do agendamento mais recente
insert into public.tutores (nome, telefone, origem, conferido)
select distinct on (tel) left(trim(tutor_nome), 120), tel, 'loja', true
from (select *, public.normalizar_tel(telefone) as tel from public.agendamentos) a
where tel is not null
order by tel, criado_em desc
on conflict (telefone) do nothing;

-- endereço do tutor: o da busca mais recente
update public.tutores t set end_cep = a.end_cep, end_rua = a.end_rua, end_numero = a.end_numero,
       end_bairro = a.end_bairro, end_cidade = a.end_cidade, end_referencia = a.end_referencia
from (select distinct on (public.normalizar_tel(telefone)) public.normalizar_tel(telefone) as tel, *
      from public.agendamentos
      where busca_domicilio and end_rua is not null and public.normalizar_tel(telefone) is not null
      order by public.normalizar_tel(telefone), criado_em desc) a
where t.telefone = a.tel and t.end_rua is null;

-- pets: um por tutor + nome; cada informação vem do agendamento mais recente que a tem
-- (assim uma alergia anotada num agendamento antigo não se perde)
insert into public.pets (tutor_id, nome, especie, sexo, nascimento, porte, raca, pelagem, peso_kg,
                         tem_saude, saude_obs, observacoes, conferido)
select g.tutor_id, g.nome, g.especie, g.sexo, public.idade_para_nascimento(g.idade), g.porte, g.raca, g.pelagem, g.peso,
       case when g.saude is not null then true end, g.saude, g.obs, true
from (
  select t.id as tutor_id,
         (array_agg(left(trim(a.pet_nome), 120) order by a.criado_em desc, a.data desc))[1]                  as nome,
         (array_agg(a.especie     order by a.criado_em desc, a.data desc) filter (where a.especie is not null))[1]     as especie,
         (array_agg(a.pet_sexo    order by a.criado_em desc, a.data desc) filter (where a.pet_sexo is not null))[1]    as sexo,
         (array_agg(a.pet_idade   order by a.criado_em desc, a.data desc) filter (where a.pet_idade is not null))[1]   as idade,
         (array_agg(a.porte       order by a.criado_em desc, a.data desc) filter (where a.porte is not null))[1]       as porte,
         (array_agg(a.raca        order by a.criado_em desc, a.data desc) filter (where a.raca is not null))[1]        as raca,
         (array_agg(a.pelagem     order by a.criado_em desc, a.data desc) filter (where a.pelagem is not null))[1]     as pelagem,
         (array_agg(a.peso_kg     order by a.criado_em desc, a.data desc) filter (where a.peso_kg is not null))[1]     as peso,
         (array_agg(a.saude_obs   order by a.criado_em desc, a.data desc) filter (where a.saude_obs is not null))[1]   as saude,
         (array_agg(a.observacoes order by a.criado_em desc, a.data desc) filter (where a.observacoes is not null))[1] as obs
  from public.agendamentos a
  join public.tutores t on t.telefone = public.normalizar_tel(a.telefone)
  where not exists (select 1 from public.pets p where p.tutor_id = t.id and lower(trim(p.nome)) = lower(trim(a.pet_nome)))
  group by t.id, lower(trim(a.pet_nome))
) g;

-- liga cada agendamento antigo ao tutor e ao pet
update public.agendamentos a set tutor_id = t.id,
       pet_id = (select p.id from public.pets p where p.tutor_id = t.id and lower(trim(p.nome)) = lower(trim(a.pet_nome))
                 order by p.criado_em limit 1)
from public.tutores t
where a.tutor_id is null and t.telefone = public.normalizar_tel(a.telefone);

alter table public.agendamentos enable trigger trg_agendamento_historico;
alter table public.agendamentos enable trigger trg_agendamento_alterar;
alter table public.agendamentos enable trigger trg_agendamento_cliente;

-- tempo real (a tela da loja atualiza quando o tutor muda algo)
do $$ begin
  alter publication supabase_realtime add table public.tutores;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.pets;
exception when duplicate_object then null; when undefined_object then null; end $$;

-- conferência
select (select count(*) from public.tutores) as tutores,
       (select count(*) from public.pets) as pets,
       (select count(*) from public.agendamentos where pet_id is not null) as agendamentos_ligados,
       (select count(*) from public.agendamentos where pet_id is null) as sem_telefone;
