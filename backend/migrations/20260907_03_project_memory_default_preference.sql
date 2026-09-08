-- Migration date: 2026-09-07
-- Per-user default for the memory setting of projects that user creates. The
-- project-level toggle is unchanged: any owner can still turn a project's
-- shared memory on or off after it exists.
alter table public.user_profiles
  add column if not exists project_memory_default boolean not null default true;
