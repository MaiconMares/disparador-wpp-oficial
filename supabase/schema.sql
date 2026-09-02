-- ─────────────────────────────────────────────────────────────────────────────
-- WhatsApp Cloud API Tester — Supabase Schema
-- Run this once on a fresh Supabase project (SQL Editor → Run).
--
-- Login multiusuário: cada linha pertence a um usuário (user_id → auth.users) e
-- as policies deixam cada usuário ver apenas as suas. Contas são criadas pelo
-- painel do Supabase (Authentication → Add user). Se você já tinha o schema
-- antigo rodando, use supabase/auth-migration.sql em vez deste arquivo.
-- ─────────────────────────────────────────────────────────────────────────────

-- sent_messages: every message this app sent out
create table if not exists sent_messages (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        references auth.users(id) on delete cascade,
  wa_message_id    text,
  recipient_number text        not null,
  message_body     text        not null,
  status           text        default 'pending', -- pending | sent | delivered | read | failed
  raw_response     jsonb,
  created_at       timestamptz default now()
);

-- incoming_messages: messages received from WhatsApp users
create table if not exists incoming_messages (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        references auth.users(id) on delete cascade,
  wa_message_id    text,
  sender_number    text        not null,
  message_type     text,
  message_body     text,
  raw_payload      jsonb,
  received_at      timestamptz default now()
);

-- message_status_updates: status callbacks (sent/delivered/read/failed)
create table if not exists message_status_updates (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        references auth.users(id) on delete cascade,
  wa_message_id    text        not null,
  recipient_number text,
  status           text        not null,
  raw_payload      jsonb,
  received_at      timestamptz default now()
);

-- Mapa Phone Number ID → usuário dono (preenchido por /api/send; usado pelos
-- webhooks para atribuir mensagens recebidas). Só o service_role acessa.
create table if not exists whatsapp_numbers (
  phone_number_id text primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  updated_at      timestamptz default now()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
create index if not exists idx_sent_messages_wa_id      on sent_messages(wa_message_id);
create index if not exists idx_sent_messages_created    on sent_messages(created_at desc);
create index if not exists idx_sent_messages_user       on sent_messages(user_id);
create index if not exists idx_incoming_messages_created on incoming_messages(received_at desc);
create index if not exists idx_incoming_messages_user    on incoming_messages(user_id);
create index if not exists idx_status_updates_wa_id     on message_status_updates(wa_message_id);
create index if not exists idx_status_updates_created   on message_status_updates(received_at desc);
create index if not exists idx_status_updates_user      on message_status_updates(user_id);

-- ─── Row Level Security ───────────────────────────────────────────────────────
-- Cada usuário autenticado só enxerga as próprias linhas. Todos os INSERT/UPDATE
-- são feitos pelas rotas /api/* com a service_role key (que ignora RLS), então
-- não há policy de escrita para o cliente.
alter table sent_messages          enable row level security;
alter table incoming_messages      enable row level security;
alter table message_status_updates enable row level security;
alter table whatsapp_numbers       enable row level security;

-- Necessário para o Realtime avaliar a policy em eventos UPDATE.
alter table sent_messages replica identity full;

create policy "Users read own rows" on sent_messages          for select to authenticated using (auth.uid() = user_id);
create policy "Users read own rows" on incoming_messages      for select to authenticated using (auth.uid() = user_id);
create policy "Users read own rows" on message_status_updates for select to authenticated using (auth.uid() = user_id);

-- ─── Realtime ─────────────────────────────────────────────────────────────────
alter publication supabase_realtime add table sent_messages;
alter publication supabase_realtime add table incoming_messages;
alter publication supabase_realtime add table message_status_updates;

-- ─────────────────────────────────────────────────────────────────────────────
-- Evolution API (WhatsApp não-oficial) — tabelas separadas das tabelas da
-- Cloud API acima, para não misturar os dois canais de disparo.
-- ─────────────────────────────────────────────────────────────────────────────

-- evolution_sent_messages: toda mensagem enviada via Evolution API
create table if not exists evolution_sent_messages (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        references auth.users(id) on delete cascade,
  wa_message_id    text,
  instance_name    text,
  sender_number    text,
  recipient_number text        not null,
  message_body     text        not null,
  status           text        default 'pending', -- pending | sent | delivered | read | failed
  raw_response     jsonb,
  created_at       timestamptz default now()
);

-- evolution_incoming_messages: mensagens recebidas de usuários via Evolution API
create table if not exists evolution_incoming_messages (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        references auth.users(id) on delete cascade,
  wa_message_id    text,
  instance_name    text,
  sender_number    text        not null,
  message_type     text,
  message_body     text,
  raw_payload      jsonb,
  received_at      timestamptz default now()
);

-- evolution_status_updates: callbacks de status (sent/delivered/read/failed)
create table if not exists evolution_status_updates (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        references auth.users(id) on delete cascade,
  wa_message_id    text        not null,
  instance_name    text,
  recipient_number text,
  status           text        not null,
  raw_payload      jsonb,
  received_at      timestamptz default now()
);

-- Mapa nome da instância → usuário dono (preenchido por /api/evolution-send e
-- /api/evolution-status; usado pelo webhook). Só o service_role acessa.
create table if not exists evolution_instances (
  instance_name text primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  updated_at    timestamptz default now()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
create index if not exists idx_evolution_sent_wa_id       on evolution_sent_messages(wa_message_id);
create index if not exists idx_evolution_sent_created     on evolution_sent_messages(created_at desc);
create index if not exists idx_evolution_sent_user        on evolution_sent_messages(user_id);
create index if not exists idx_evolution_incoming_created on evolution_incoming_messages(received_at desc);
create index if not exists idx_evolution_incoming_user    on evolution_incoming_messages(user_id);
create index if not exists idx_evolution_status_wa_id     on evolution_status_updates(wa_message_id);
create index if not exists idx_evolution_status_created   on evolution_status_updates(received_at desc);
create index if not exists idx_evolution_status_user      on evolution_status_updates(user_id);

-- ─── Row Level Security ───────────────────────────────────────────────────────
-- Cada usuário autenticado só enxerga as próprias linhas; escrita só via API
-- (service_role, que ignora RLS).
alter table evolution_sent_messages     enable row level security;
alter table evolution_incoming_messages enable row level security;
alter table evolution_status_updates    enable row level security;
alter table evolution_instances         enable row level security;

alter table evolution_sent_messages replica identity full;

create policy "Users read own rows" on evolution_sent_messages     for select to authenticated using (auth.uid() = user_id);
create policy "Users read own rows" on evolution_incoming_messages for select to authenticated using (auth.uid() = user_id);
create policy "Users read own rows" on evolution_status_updates    for select to authenticated using (auth.uid() = user_id);

-- ─── Realtime ─────────────────────────────────────────────────────────────────
alter publication supabase_realtime add table evolution_sent_messages;
alter publication supabase_realtime add table evolution_incoming_messages;
alter publication supabase_realtime add table evolution_status_updates;
