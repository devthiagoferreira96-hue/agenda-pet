-- =====================================================================
-- AGENDA PET – Atualização v5: cadastro de clientes (tutores e pets)
-- Rode no Supabase: SQL Editor > New query > cole tudo > Run.
-- Pode rodar de novo sem problema. Não apaga nada do que já existe.
--
-- O que faz:
--  1. Cria as tabelas "tutores" e "pets" (base única para PetShop e Banho e Tosa)
--  2. Regras de acesso: a equipe vê todos; o tutor (área do tutor) vê só ele e os pets dele
--  3. Cada agendamento salvo com telefone passa a ficar ligado ao tutor e ao pet
--     (se o tutor/pet ainda não existir, o banco cria sozinho)
--  4. Importa os clientes dos agendamentos que já existem (agrupando pelo telefone)
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
