-- plastron supabase-storage test fixture: a private bucket + RLS letting an
-- authenticated user CRUD objects in it (and read the bucket list).
insert into storage.buckets (id, name, public)
  values ('plastron-test', 'plastron-test', false)
  on conflict (id) do nothing;

create policy "plastron_test_objects_all" on storage.objects
  for all to authenticated
  using (bucket_id = 'plastron-test')
  with check (bucket_id = 'plastron-test');

create policy "plastron_test_buckets_select" on storage.buckets
  for select to authenticated using (true);
