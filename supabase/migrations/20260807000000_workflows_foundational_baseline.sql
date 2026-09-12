begin;

do $baseline$
declare
  workflows_oid oid;
  workflows_kind "char";
  column_type oid;
  column_not_null boolean;
  column_default text;
  id_attnum smallint;
  primary_key_name text;
  primary_key_columns smallint[];
begin
  select relation.oid, relation.relkind
  into workflows_oid, workflows_kind
  from pg_catalog.pg_class as relation
  join pg_catalog.pg_namespace as namespace
    on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relname = 'workflows';

  if workflows_oid is null then
    create table public.workflows (
      id uuid not null default gen_random_uuid(),
      name text not null,
      prompt text not null,
      compiled_steps jsonb null,
      status text null default 'draft'::text,
      created_at timestamptz null default now(),
      constraint workflows_pkey primary key (id)
    );

    return;
  end if;

  if workflows_kind not in ('r', 'p') then
    raise exception
      'public.workflows baseline assertion failed: expected a table, found relkind %',
      workflows_kind;
  end if;

  select attribute.atttypid,
         attribute.attnotnull,
         pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid, false),
         attribute.attnum
  into column_type, column_not_null, column_default, id_attnum
  from pg_catalog.pg_attribute as attribute
  left join pg_catalog.pg_attrdef as default_value
    on default_value.adrelid = attribute.attrelid
   and default_value.adnum = attribute.attnum
  where attribute.attrelid = workflows_oid
    and attribute.attname = 'id'
    and attribute.attnum > 0
    and not attribute.attisdropped;

  if not found then
    raise exception 'public.workflows baseline assertion failed: column id is missing';
  end if;
  if column_type <> 'uuid'::pg_catalog.regtype then
    raise exception 'public.workflows baseline assertion failed: id must be uuid';
  end if;
  if not column_not_null then
    raise exception 'public.workflows baseline assertion failed: id must be NOT NULL';
  end if;
  if column_default is null
     or pg_catalog.regexp_replace(column_default, '\s+', '', 'g')
        !~ '^\(*((pg_catalog|extensions)\.)?gen_random_uuid\(\)\)*$' then
    raise exception
      'public.workflows baseline assertion failed: id default must be gen_random_uuid()';
  end if;

  select constraint_record.conname, constraint_record.conkey
  into primary_key_name, primary_key_columns
  from pg_catalog.pg_constraint as constraint_record
  where constraint_record.conrelid = workflows_oid
    and constraint_record.contype = 'p';

  if not found then
    raise exception 'public.workflows baseline assertion failed: primary key is missing';
  end if;
  if primary_key_name <> 'workflows_pkey'
     or primary_key_columns <> array[id_attnum]::smallint[] then
    raise exception
      'public.workflows baseline assertion failed: primary key must be workflows_pkey on id only';
  end if;

  select attribute.atttypid,
         attribute.attnotnull,
         pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid, false)
  into column_type, column_not_null, column_default
  from pg_catalog.pg_attribute as attribute
  left join pg_catalog.pg_attrdef as default_value
    on default_value.adrelid = attribute.attrelid
   and default_value.adnum = attribute.attnum
  where attribute.attrelid = workflows_oid
    and attribute.attname = 'name'
    and attribute.attnum > 0
    and not attribute.attisdropped;

  if not found then
    raise exception 'public.workflows baseline assertion failed: column name is missing';
  end if;
  if column_type <> 'text'::pg_catalog.regtype
     or not column_not_null
     or column_default is not null then
    raise exception
      'public.workflows baseline assertion failed: name must be text NOT NULL with no default';
  end if;

  select attribute.atttypid,
         attribute.attnotnull,
         pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid, false)
  into column_type, column_not_null, column_default
  from pg_catalog.pg_attribute as attribute
  left join pg_catalog.pg_attrdef as default_value
    on default_value.adrelid = attribute.attrelid
   and default_value.adnum = attribute.attnum
  where attribute.attrelid = workflows_oid
    and attribute.attname = 'prompt'
    and attribute.attnum > 0
    and not attribute.attisdropped;

  if not found then
    raise exception 'public.workflows baseline assertion failed: column prompt is missing';
  end if;
  if column_type <> 'text'::pg_catalog.regtype
     or not column_not_null
     or column_default is not null then
    raise exception
      'public.workflows baseline assertion failed: prompt must be text NOT NULL with no default';
  end if;

  select attribute.atttypid,
         attribute.attnotnull,
         pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid, false)
  into column_type, column_not_null, column_default
  from pg_catalog.pg_attribute as attribute
  left join pg_catalog.pg_attrdef as default_value
    on default_value.adrelid = attribute.attrelid
   and default_value.adnum = attribute.attnum
  where attribute.attrelid = workflows_oid
    and attribute.attname = 'compiled_steps'
    and attribute.attnum > 0
    and not attribute.attisdropped;

  if not found then
    raise exception 'public.workflows baseline assertion failed: column compiled_steps is missing';
  end if;
  if column_type <> 'jsonb'::pg_catalog.regtype
     or column_not_null
     or column_default is not null then
    raise exception
      'public.workflows baseline assertion failed: compiled_steps must be nullable jsonb with no default';
  end if;

  select attribute.atttypid,
         attribute.attnotnull,
         pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid, false)
  into column_type, column_not_null, column_default
  from pg_catalog.pg_attribute as attribute
  left join pg_catalog.pg_attrdef as default_value
    on default_value.adrelid = attribute.attrelid
   and default_value.adnum = attribute.attnum
  where attribute.attrelid = workflows_oid
    and attribute.attname = 'status'
    and attribute.attnum > 0
    and not attribute.attisdropped;

  if not found then
    raise exception 'public.workflows baseline assertion failed: column status is missing';
  end if;
  if column_type <> 'text'::pg_catalog.regtype or column_not_null then
    raise exception 'public.workflows baseline assertion failed: status must be nullable text';
  end if;
  if column_default is null
     or pg_catalog.regexp_replace(column_default, '\s+', '', 'g')
        !~ '^\(*''draft''::text\)*$' then
    raise exception
      'public.workflows baseline assertion failed: status default must be draft';
  end if;

  select attribute.atttypid,
         attribute.attnotnull,
         pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid, false)
  into column_type, column_not_null, column_default
  from pg_catalog.pg_attribute as attribute
  left join pg_catalog.pg_attrdef as default_value
    on default_value.adrelid = attribute.attrelid
   and default_value.adnum = attribute.attnum
  where attribute.attrelid = workflows_oid
    and attribute.attname = 'created_at'
    and attribute.attnum > 0
    and not attribute.attisdropped;

  if not found then
    raise exception 'public.workflows baseline assertion failed: column created_at is missing';
  end if;
  if column_type <> 'timestamp with time zone'::pg_catalog.regtype or column_not_null then
    raise exception
      'public.workflows baseline assertion failed: created_at must be nullable timestamptz';
  end if;
  if column_default is null
     or pg_catalog.regexp_replace(column_default, '\s+', '', 'g')
        !~* '^\(*((pg_catalog\.)?now\(\)|CURRENT_TIMESTAMP)\)*$' then
    raise exception
      'public.workflows baseline assertion failed: created_at default must be now()';
  end if;
end
$baseline$;

commit;
