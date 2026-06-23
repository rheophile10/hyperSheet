-- plastron supabase-library test fixture: a tiny RLS-protected, realtime-enabled table.
create table if not exists public.todos (
  id         bigint generated always as identity primary key,
  owner      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title      text not null,
  done       boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.todos enable row level security;

create policy "todos_select_own" on public.todos for select using (auth.uid() = owner);
create policy "todos_insert_own" on public.todos for insert with check (auth.uid() = owner);
create policy "todos_update_own" on public.todos for update using (auth.uid() = owner);
create policy "todos_delete_own" on public.todos for delete using (auth.uid() = owner);

-- realtime: broadcast row changes on this table
alter publication supabase_realtime add table public.todos;
