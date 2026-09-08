-- Migration date: 2026-09-07
-- `version` never named a version once history was removed: it is a monotonic
-- change token for compare-and-swap, and no value of it is retained. Rename it
-- to `revision` everywhere it surfaces so the schema stops implying a history
-- that does not exist. `epoch` keeps its name — it means something else (the
-- erase generation).

alter table public.memory_files
  rename column version to revision;
alter table public.memory_consolidation_results
  rename column version to revision;

-- A renamed column keeps the constraint name Postgres generated for its old
-- one; a fresh install names it after `revision`.
alter table public.memory_files
  rename constraint memory_files_version_check to memory_files_revision_check;

-- Parameter and return-column names cannot be changed by `create or replace`.
drop function if exists public.write_memory_file(
  uuid, bigint, bigint, text, text, integer, text, uuid, text, uuid, uuid, uuid, bigint, bigint, bigint
);
drop function if exists public.wipe_memory_file(uuid, boolean, uuid, text);
drop function if exists public.enable_memory_file(uuid, uuid);

create or replace function public.write_memory_file(
  p_memory_file_id uuid,
  p_expected_revision bigint,
  p_expected_epoch bigint,
  p_content text,
  p_content_sha256 text,
  p_size_bytes integer,
  p_source text,
  p_updated_by uuid default null,
  p_source_surface text default null,
  p_source_chat_id uuid default null,
  p_source_job_id uuid default null,
  p_consolidation_state_id uuid default null,
  p_consolidation_generation bigint default null,
  p_conversation_generation bigint default null,
  p_source_epoch bigint default null
)
returns table(applied boolean, new_revision bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.memory_files%rowtype;
  consolidation public.memory_consolidation_states%rowtype;
  activity public.memory_conversation_activity%rowtype;
begin
  if p_source not in ('manual', 'curator') then
    raise exception using errcode = '22023', message = 'invalid_memory_source';
  end if;
  if p_size_bytes < 0 or p_size_bytes > 16384 then
    raise exception using errcode = '22023', message = 'memory_content_too_large';
  end if;
  -- Match canonical DELETE's source -> scheduler-state lock order. Holding
  -- this key-share lock through the write makes deletion and learning
  -- serialize without a check/write gap.
  if p_source = 'curator' then
    if p_consolidation_state_id is null
      or p_consolidation_generation is null
      or p_conversation_generation is null
      or p_source_surface is null
      or p_source_chat_id is null
      or p_source_epoch is null
    then
      raise exception using errcode = '22023', message = 'memory_curator_fence_required';
    end if;
    perform locked.locked_project_id
    from public.lock_memory_conversation_source(
      p_source_surface, p_source_chat_id, p_updated_by
    ) locked;
    if not found then
      raise exception using errcode = '40001', message = 'memory_job_superseded';
    end if;
    select * into activity from public.memory_conversation_activity
    where surface = p_source_surface and conversation_id = p_source_chat_id
    for update;
    if not found
      or activity.deleted_at is not null
      or activity.source_epoch <> p_source_epoch
      or activity.generation <> p_conversation_generation
    then
      raise exception using errcode = '40001', message = 'memory_job_superseded';
    end if;
    if activity.quiet_until is null
      or activity.quiet_until > now()
      or exists (
        select 1 from public.memory_conversation_turn_leases lease
        where lease.surface = p_source_surface
          and lease.conversation_id = p_source_chat_id
          and lease.expires_at > now()
      )
    then
      raise exception using errcode = '55000', message = 'memory_conversation_not_quiet';
    end if;
    select * into consolidation from public.memory_consolidation_states
    where id = p_consolidation_state_id for update;
    if not found
      or consolidation.generation <> p_consolidation_generation
      or consolidation.conversation_generation <> p_conversation_generation
      or consolidation.surface <> p_source_surface
      or consolidation.conversation_id <> p_source_chat_id
      or consolidation.source_epoch <> p_source_epoch
      or consolidation.actor_user_id is distinct from p_updated_by
    then
      raise exception using errcode = '40001', message = 'memory_job_superseded';
    end if;
  end if;

  select * into target from public.memory_files
  where id = p_memory_file_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'memory_file_not_found';
  end if;

  -- A curator job that is retried after its transaction already committed
  -- must not apply the same replacement twice.
  if p_source_job_id is not null
    and target.last_source_job_id = p_source_job_id
  then
    return query select false, target.revision;
    return;
  end if;

  if p_source = 'curator' then
    if (target.scope = 'user' and target.user_id <> consolidation.actor_user_id)
      or (target.scope = 'project' and target.project_id is distinct from consolidation.project_id)
    then
      raise exception using errcode = '40001', message = 'memory_job_superseded';
    end if;
  end if;

  if not target.enabled then
    raise exception using errcode = 'P0001', message = 'memory_disabled';
  end if;
  if target.epoch <> p_expected_epoch then
    raise exception using errcode = '40001', message = 'memory_epoch_conflict';
  end if;
  if target.revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'memory_revision_conflict';
  end if;

  update public.memory_files
  set content = p_content,
      content_sha256 = p_content_sha256,
      size_bytes = p_size_bytes,
      revision = target.revision + 1,
      last_error_code = null,
      last_source = p_source,
      last_source_job_id = p_source_job_id,
      updated_by = p_updated_by,
      updated_at = now()
  where id = p_memory_file_id;

  if p_source_job_id is not null then
    insert into public.memory_consolidation_results(
      job_id, memory_file_id, scope, outcome, revision
    ) values (
      p_source_job_id, target.id, target.scope, 'updated', target.revision + 1
    ) on conflict (job_id, memory_file_id) do update
      set outcome = excluded.outcome,
          revision = excluded.revision,
          created_at = now();
  end if;

  return query select true, target.revision + 1;
end;
$$;

create or replace function public.wipe_memory_file(
  p_memory_file_id uuid,
  p_enabled boolean,
  p_updated_by uuid default null,
  p_source text default 'wipe'
)
returns table(
  new_epoch bigint,
  new_revision bigint,
  effective_enabled boolean,
  mutation_at timestamptz,
  mutation_by uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.memory_files%rowtype;
  changed_at timestamptz := now();
begin
  if p_source not in ('wipe', 'settings') then
    raise exception using errcode = '22023', message = 'invalid_memory_source';
  end if;
  select * into target from public.memory_files
  where id = p_memory_file_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'memory_file_not_found';
  end if;

  -- The body lives on this row, so erasure is the same UPDATE that fences
  -- in-flight curator work: the epoch bump supersedes any job that read the
  -- old content, and the revision bump invalidates loaded editor drafts.
  update public.memory_files
  set enabled = coalesce(p_enabled, target.enabled),
      epoch = target.epoch + 1,
      revision = target.revision + 1,
      learning_cutoff_at = changed_at,
      content = '',
      content_sha256 = null,
      size_bytes = 0,
      status = 'idle',
      last_error_code = null,
      last_source = p_source,
      last_source_job_id = null,
      updated_by = p_updated_by,
      updated_at = changed_at
  where id = target.id;

  return query select
    target.epoch + 1,
    target.revision + 1,
    coalesce(p_enabled, target.enabled),
    changed_at,
    p_updated_by;
end;
$$;

create or replace function public.enable_memory_file(
  p_memory_file_id uuid,
  p_updated_by uuid
)
returns table(
  effective_enabled boolean,
  new_epoch bigint,
  new_revision bigint,
  mutation_at timestamptz,
  mutation_by uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.memory_files%rowtype;
  changed_at timestamptz := now();
begin
  select * into target from public.memory_files
  where id = p_memory_file_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'memory_file_not_found';
  end if;
  if target.enabled then
    return query select true, target.epoch, target.revision,
      target.updated_at, target.updated_by;
    return;
  end if;
  update public.memory_files memory_file
  set enabled = true,
      epoch = target.epoch + 1,
      revision = target.revision + 1,
      learning_cutoff_at = changed_at,
      content = '',
      content_sha256 = null,
      size_bytes = 0,
      last_source_job_id = null,
      status = 'idle',
      last_error_code = null,
      last_source = 'settings',
      updated_by = p_updated_by,
      updated_at = changed_at
  where memory_file.id = target.id;
  return query select true, target.epoch + 1, target.revision + 1,
    changed_at, p_updated_by;
end;
$$;

revoke all on function public.write_memory_file(uuid, bigint, bigint, text, text, integer, text, uuid, text, uuid, uuid, uuid, bigint, bigint, bigint)
  from public, anon, authenticated;
revoke all on function public.wipe_memory_file(uuid, boolean, uuid, text)
  from public, anon, authenticated;
revoke all on function public.enable_memory_file(uuid, uuid)
  from public, anon, authenticated;
grant execute
  on function public.write_memory_file(uuid, bigint, bigint, text, text, integer, text, uuid, text, uuid, uuid, uuid, bigint, bigint, bigint)
  to service_role;
grant execute
  on function public.wipe_memory_file(uuid, boolean, uuid, text)
  to service_role;
grant execute
  on function public.enable_memory_file(uuid, uuid)
  to service_role;
