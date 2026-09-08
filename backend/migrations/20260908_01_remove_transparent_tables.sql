-- Migration date: 2026-09-08

alter table public.user_profiles
  drop column if exists transparent_tables;
