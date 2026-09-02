-- ─────────────────────────────────────────────────────────────────────────────
-- WA Disparador — Migração para LOGIN MULTIUSUÁRIO
--
-- Rode este script UMA VEZ no seu projeto Supabase (SQL Editor → Run), depois
-- de já ter rodado o schema.sql original. Ele:
--   1. adiciona a coluna user_id em todas as tabelas de dados;
--   2. cria as tabelas de mapeamento canal→usuário (whatsapp_numbers,
--      evolution_instances) usadas pelos webhooks para atribuir as mensagens
--      recebidas ao dono correto;
--   3. troca as policies permissivas por policies "cada usuário vê só o seu";
--   4. cria a primeira conta (e-mail/senha abaixo);
--   5. vincula TODO o histórico existente à conta ssolucoesempresariais4@gmail.com.
--
-- Contas novas são criadas pelo painel do Supabase (Authentication → Add user),
-- não há cadastro público no app.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto;

-- ─── 1. Coluna user_id ───────────────────────────────────────────────────────
alter table sent_messages              add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table incoming_messages          add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table message_status_updates     add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table evolution_sent_messages    add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table evolution_incoming_messages add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table evolution_status_updates   add column if not exists user_id uuid references auth.users(id) on delete cascade;

create index if not exists idx_sent_messages_user      on sent_messages(user_id);
create index if not exists idx_incoming_messages_user  on incoming_messages(user_id);
create index if not exists idx_status_updates_user     on message_status_updates(user_id);
create index if not exists idx_evo_sent_user           on evolution_sent_messages(user_id);
create index if not exists idx_evo_incoming_user       on evolution_incoming_messages(user_id);
create index if not exists idx_evo_status_user         on evolution_status_updates(user_id);

-- Necessário para o Realtime avaliar a policy em eventos UPDATE.
alter table sent_messages           replica identity full;
alter table evolution_sent_messages replica identity full;

-- ─── 2. Mapas canal → usuário ────────────────────────────────────────────────
-- Preenchidos pela API a cada envio / verificação de status. Só o service_role
-- lê/escreve nessas tabelas (RLS ligada, sem policy = ninguém mais acessa).
create table if not exists whatsapp_numbers (
  phone_number_id text primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  updated_at      timestamptz default now()
);

create table if not exists evolution_instances (
  instance_name text primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  updated_at    timestamptz default now()
);

alter table whatsapp_numbers    enable row level security;
alter table evolution_instances enable row level security;

-- ─── 3. Policies "cada usuário vê só o seu" ──────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'sent_messages','incoming_messages','message_status_updates',
    'evolution_sent_messages','evolution_incoming_messages','evolution_status_updates'
  ] loop
    execute format('drop policy if exists "Allow anon read"   on %I', t);
    execute format('drop policy if exists "Allow anon insert" on %I', t);
    execute format('drop policy if exists "Allow anon update" on %I', t);
    execute format('drop policy if exists "Users read own rows" on %I', t);
    execute format(
      'create policy "Users read own rows" on %I for select to authenticated using (auth.uid() = user_id)', t);
  end loop;
end $$;

-- ─── 4. Primeira conta ──────────────────────────────────────────────────────
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  raw_app_meta_data, raw_user_meta_data
)
select
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
  'ssolucoesempresariais4@gmail.com', crypt('!GengisKan731', gen_salt('bf')),
  now(), now(), now(),
  '', '', '', '',
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb
where not exists (
  select 1 from auth.users where email = 'ssolucoesempresariais4@gmail.com'
);

insert into auth.identities (
  provider_id, user_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
)
select
  u.id::text, u.id,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true, 'phone_verified', false),
  'email', now(), now(), now()
from auth.users u
where u.email = 'ssolucoesempresariais4@gmail.com'
  and not exists (
    select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email'
  );

-- ─── 5. Vincular TODO o histórico atual à conta ssolucoesempresariais4@gmail.com
-- Toda linha existente (todas estão com user_id nulo, pois a coluna acabou de
-- ser criada) passa a pertencer a essa conta.
do $$
declare owner_id uuid;
begin
  select id into owner_id from auth.users where email = 'ssolucoesempresariais4@gmail.com';
  if owner_id is null then
    raise exception 'Conta ssolucoesempresariais4@gmail.com não encontrada — o passo 4 falhou.';
  end if;

  update sent_messages              set user_id = owner_id where user_id is null;
  update incoming_messages          set user_id = owner_id where user_id is null;
  update message_status_updates     set user_id = owner_id where user_id is null;
  update evolution_sent_messages    set user_id = owner_id where user_id is null;
  update evolution_incoming_messages set user_id = owner_id where user_id is null;
  update evolution_status_updates   set user_id = owner_id where user_id is null;

  -- Registra as instâncias da Evolution já vistas no histórico, para que as
  -- próximas mensagens recebidas (webhook) caiam nessa conta sem reenviar nada.
  insert into evolution_instances (instance_name, user_id)
    select distinct instance_name, owner_id
    from evolution_sent_messages
    where instance_name is not null
  on conflict (instance_name) do nothing;
end $$;

-- Cloud API: registre aqui o seu Phone Number ID (o mesmo valor da variável
-- PHONE_NUMBER_ID na Vercel) para já direcionar as mensagens recebidas à conta.
-- Troque <SEU_PHONE_NUMBER_ID> e rode; ou simplesmente envie 1 mensagem pelo
-- painel depois do deploy, que a rota /api/send registra isso sozinha.
-- insert into whatsapp_numbers (phone_number_id, user_id)
-- select '<SEU_PHONE_NUMBER_ID>', id from auth.users
-- where email = 'ssolucoesempresariais4@gmail.com'
-- on conflict (phone_number_id) do update set user_id = excluded.user_id;
