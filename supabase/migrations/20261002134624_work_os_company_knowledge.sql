begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('company_knowledge', 'company_knowledge', false, 3145728,
  array['application/pdf', 'text/plain', 'text/markdown'])
on conflict (id) do update set public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- There are deliberately no storage.objects policies for this bucket. Only
-- server-held service credentials may upload/remove objects; application
-- reads require a fresh workspace-membership check before any signed access.
create table public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  uploaded_by_user_id uuid references auth.users(id) on delete set null,
  title text not null check (char_length(title) between 1 and 180),
  filename text not null check (char_length(filename) between 1 and 255),
  mime_type text not null check (mime_type in ('application/pdf', 'text/plain', 'text/markdown')),
  size_bytes integer not null check (size_bytes between 1 and 3145728),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  storage_path text not null unique,
  status text not null default 'processing' check (status in ('processing', 'ready', 'failed', 'deleting')),
  page_count integer check (page_count between 1 and 30),
  character_count integer check (character_count between 0 and 80000),
  chunk_count integer check (chunk_count between 0 and 200),
  failure_reason text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, id),
  unique (workspace_id, sha256),
  check (status <> 'ready' or (character_count > 0 and chunk_count > 0))
);

create index knowledge_documents_uploader_idx on public.knowledge_documents(uploaded_by_user_id);
create index knowledge_documents_workspace_created_idx on public.knowledge_documents(workspace_id, created_at desc);

create function public.enforce_knowledge_document_limit()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('knowledge-limit:' || new.workspace_id::text, 0));
  if (select count(*) from public.knowledge_documents d where d.workspace_id = new.workspace_id) >= 50 then
    raise exception 'Company knowledge document limit reached';
  end if;
  return new;
end;
$$;
create trigger knowledge_document_limit before insert on public.knowledge_documents
  for each row execute function public.enforce_knowledge_document_limit();
revoke all on function public.enforce_knowledge_document_limit() from public, anon, authenticated;

create table public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id uuid not null,
  chunk_index integer not null check (chunk_index between 0 and 199),
  page_number integer check (page_number between 1 and 30),
  content text not null check (char_length(content) between 1 and 900),
  search_vector tsvector generated always as (to_tsvector('english'::regconfig, content)) stored,
  unique (document_id, chunk_index),
  foreign key (workspace_id, document_id)
    references public.knowledge_documents(workspace_id, id) on delete cascade
);

create index knowledge_chunks_workspace_document_idx on public.knowledge_chunks(workspace_id, document_id);
create index knowledge_chunks_search_idx on public.knowledge_chunks using gin(search_vector);

alter table public.knowledge_documents enable row level security;
alter table public.knowledge_documents force row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.knowledge_chunks force row level security;
revoke all on public.knowledge_documents, public.knowledge_chunks from public, anon, authenticated;
grant select on public.knowledge_documents, public.knowledge_chunks to authenticated;
grant select, insert, update, delete on public.knowledge_documents, public.knowledge_chunks to service_role;

create policy knowledge_documents_member_select on public.knowledge_documents
  for select to authenticated using (
    exists (select 1 from public.workspace_memberships m
      where m.workspace_id = knowledge_documents.workspace_id
        and m.user_id = (select auth.uid()))
  );
create policy knowledge_chunks_member_select on public.knowledge_chunks
  for select to authenticated using (
    exists (select 1 from public.workspace_memberships m
      where m.workspace_id = knowledge_chunks.workspace_id
        and m.user_id = (select auth.uid()))
    and exists (select 1 from public.knowledge_documents d
      where d.workspace_id = knowledge_chunks.workspace_id
        and d.id = knowledge_chunks.document_id and d.status = 'ready')
  );

-- Invoker + service-role-only grant. The explicit actor membership check is
-- necessary even though the service key bypasses RLS.
create function public.search_company_knowledge(
  p_actor_user_id uuid, p_workspace_id uuid, p_query text, p_limit integer default 8
)
returns table (
  chunk_id uuid, document_id uuid, document_title text, chunk_index integer,
  page_number integer, content text, rank real
)
language plpgsql security invoker set search_path = '' as $$
declare v_query tsquery;
begin
  if p_actor_user_id is null or p_workspace_id is null
    or p_query is null or char_length(p_query) not between 1 and 400
    or not exists (select 1 from public.workspace_memberships m
      where m.workspace_id = p_workspace_id and m.user_id = p_actor_user_id
        and m.is_default)
  then raise exception 'Company knowledge is unavailable'; end if;
  v_query := websearch_to_tsquery('english'::regconfig, p_query);
  if numnode(v_query) = 0 then return; end if;
  return query
    with ranked as (
      select c.id, c.document_id, d.title, c.chunk_index, c.page_number,
        c.content, ts_rank_cd(c.search_vector, v_query) as score,
        row_number() over (partition by c.document_id
          order by ts_rank_cd(c.search_vector, v_query) desc, c.chunk_index) as per_document
      from public.knowledge_chunks c
      join public.knowledge_documents d on d.id = c.document_id and d.workspace_id = c.workspace_id
      where c.workspace_id = p_workspace_id and d.status = 'ready'
        and c.search_vector @@ v_query
    )
    select ranked.id, ranked.document_id, ranked.title, ranked.chunk_index,
      ranked.page_number, ranked.content, ranked.score
    from ranked where ranked.per_document <= 2
    order by ranked.score desc, ranked.document_id, ranked.chunk_index
    limit least(greatest(coalesce(p_limit, 8), 1), 8);
end;
$$;
revoke all on function public.search_company_knowledge(uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.search_company_knowledge(uuid, uuid, text, integer) to service_role;

commit;
