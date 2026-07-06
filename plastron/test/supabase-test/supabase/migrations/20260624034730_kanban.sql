-- per-user kanban for the login+kanban demo (origin-user segment).
create table if not exists public.kanban (
  id         bigint generated always as identity primary key,
  owner      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title      text not null,
  status     text not null default 'todo' check (status in ('todo','doing','done')),
  position   int  not null default 0,
  created_at timestamptz not null default now()
);
alter table public.kanban enable row level security;
create policy kanban_all_own on public.kanban for all to authenticated
  using (auth.uid() = owner) with check (auth.uid() = owner);
