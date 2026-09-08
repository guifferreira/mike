-- Migration date: 2026-09-07
-- Optional per-user override for the model used by asynchronous memory
-- curation. NULL preserves the automatic lightweight-model selection.

alter table public.user_profiles
  add column if not exists memory_curator_model text;
