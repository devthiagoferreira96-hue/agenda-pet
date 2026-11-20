-- AGENDA PET – Lista pets com idade impossível (mais de 35 anos). Só LÊ, não muda nada.
-- Se aparecer algum, corrija a idade pela agenda (Editar) antes de rodar a atualização v5.
select data, horario, pet_nome, tutor_nome, pet_idade
from public.agendamentos
where pet_idade is not null
  and ((pet_idade ~* 'm[eê]s|meses' and coalesce((regexp_match(pet_idade, '(\d{1,3})'))[1]::int, 0) > 420)
    or (pet_idade !~* 'm[eê]s|meses' and coalesce((regexp_match(pet_idade, '(\d{1,3})'))[1]::int, 0) > 35));
