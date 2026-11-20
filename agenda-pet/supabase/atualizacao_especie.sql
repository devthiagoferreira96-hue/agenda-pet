-- =====================================================================
-- AGENDA PET – Atualização: campo "Espécie" (Canino / Felino)
-- Rode UMA vez no Supabase: SQL Editor > New query > Run.
-- Não apaga nada: só acrescenta a coluna nova.
-- =====================================================================
alter table public.agendamentos add column if not exists especie text;

do $$ begin
  alter table public.agendamentos
    add constraint agendamentos_especie_check check (especie in ('Canino', 'Felino'));
exception when duplicate_object then null; end $$;
