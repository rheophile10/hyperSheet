-- enable realtime on storage object changes so a sheet can subscribe to uploads.
alter publication supabase_realtime add table storage.objects;
