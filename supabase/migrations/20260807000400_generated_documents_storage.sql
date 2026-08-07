begin;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'generated_documents',
  'generated_documents',
  true,
  5242880,
  array['application/pdf']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can upload their generated documents" on storage.objects;
drop policy if exists "Users can read their generated documents" on storage.objects;
drop policy if exists "Users can delete their generated documents" on storage.objects;

create policy "Users can upload their generated documents"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'generated_documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users can read their generated documents"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'generated_documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users can delete their generated documents"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'generated_documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

commit;
