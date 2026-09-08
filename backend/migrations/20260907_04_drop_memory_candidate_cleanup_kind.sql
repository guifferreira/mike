-- Migration date: 2026-09-07
-- The `memory.candidate_cleanup` job kind is gone: memory bodies live on
-- memory_files, so there are no staged objects to reclaim and nothing
-- enqueues that kind any more (20260907_02 dropped the handler and deleted
-- the pending rows). These two claim functions were the last place naming it.
-- Behaviour is otherwise unchanged: `storage.cleanup` is still the kind that
-- retries forever and survives the retention sweep.

-- The partial index that keeps failed cleanup rows cheap to find carried the
-- kind in its predicate, so it has to be rebuilt rather than replaced.
drop index if exists public.db_jobs_failed_cleanup_run_at_idx;
create index if not exists db_jobs_failed_cleanup_run_at_idx
  on public.db_jobs(run_at)
  where status = 'failed'
    and kind = 'storage.cleanup';

create or replace function public.claim_db_jobs(
  p_limit integer default 5,
  p_stale_seconds integer default 600
)
returns setof public.db_jobs
language sql
as $$
  with abandoned as (
    update public.db_jobs
       set status = 'failed',
           finished_at = now(),
           last_error = coalesce(
             last_error,
             'abandoned: worker died mid-run and attempts are exhausted'
           )
     where status = 'running'
       and claimed_at < now() - make_interval(secs => p_stale_seconds)
       and attempts >= max_attempts
       and kind <> 'storage.cleanup'
    returning id
  ), candidates as (
    select id
      from public.db_jobs
     where (status = 'pending' and run_at <= now())
        or (status = 'failed'
            and kind = 'storage.cleanup')
        or (status = 'running'
            and claimed_at < now() - make_interval(secs => p_stale_seconds)
            and (
              attempts < max_attempts
              or kind = 'storage.cleanup'
            ))
     order by run_at
     limit p_limit
       for update skip locked
  )
  update public.db_jobs j
     set status = 'running',
         claimed_at = now(),
         finished_at = null,
         attempts = case
           when j.kind = 'storage.cleanup'
             then least(j.attempts::bigint + 1, 2147483647)::integer
           else j.attempts + 1
         end,
         max_attempts = case
           when j.kind = 'storage.cleanup'
             then 2147483647
           else j.max_attempts
         end,
         dedupe_key = case
           when j.status = 'failed'
             and j.kind = 'storage.cleanup'
             then null
           else j.dedupe_key
         end
    from candidates c
   where j.id = c.id
  returning j.*;
$$;

create or replace function public.claim_db_job(
  p_id uuid,
  p_stale_seconds integer default 600
)
returns setof public.db_jobs
language sql
as $$
  update public.db_jobs j
     set status = 'running',
         claimed_at = now(),
         finished_at = null,
         attempts = case
           when j.kind = 'storage.cleanup'
             then least(j.attempts::bigint + 1, 2147483647)::integer
           else j.attempts + 1
         end,
         max_attempts = case
           when j.kind = 'storage.cleanup'
             then 2147483647
           else j.max_attempts
         end,
         dedupe_key = case
           when j.status = 'failed'
             and j.kind = 'storage.cleanup'
             then null
           else j.dedupe_key
         end
   where j.id = p_id
     and ((j.status = 'pending' and j.run_at <= now())
       or (j.status = 'failed'
           and j.kind = 'storage.cleanup')
       or (j.status = 'running'
           and j.claimed_at < now() - make_interval(secs => p_stale_seconds)
           and (
             j.attempts < j.max_attempts
             or j.kind = 'storage.cleanup'
           )))
  returning j.*;
$$;
