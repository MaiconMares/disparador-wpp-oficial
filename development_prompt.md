# Implementation Prompt: WhatsApp Cloud API Test App

## Project Overview

Build a simple single-page web application to test the official WhatsApp Cloud API (Meta). The app must:

1. Send a text message to a single WhatsApp number or a list of numbers (comma-separated input).
2. Receive incoming WhatsApp messages and message status updates (sent/delivered/read/failed) via webhook.
3. Persist every sent message, incoming message, and status update to Supabase.
4. Automatically connect to Supabase the moment the page loads, and display incoming messages/status updates live (via Supabase Realtime, not manual refresh).
5. Deploy as a single Vercel project (static frontend + serverless functions — no separate backend server).

## Tech Stack

- **Frontend**: plain HTML, CSS, vanilla JS (no framework, no build step)
- **Backend**: Vercel Serverless Functions (Node.js, in `/api`)
- **Database**: Supabase (Postgres + Realtime)
- **External API**: Meta WhatsApp Cloud API (Graph API v25.0)

## File Structure to Create

```
/public
  index.html
  style.css
  app.js
/api
  send.js
  webhook.js
supabase/
  schema.sql
.env.example
vercel.json
README.md
```

## Step-by-Step Requirements

### Step 1 — `/api/send.js` (Serverless Function)

- Accepts `POST` with JSON body: `{ message: string, numbers: string[] }`.
- Reads `WHATSAPP_TOKEN` and `PHONE_NUMBER_ID` from environment variables (never hardcode secrets, never expose them to the client).
- Loops through `numbers` and sends a `POST` to `https://graph.facebook.com/v25.0/{PHONE_NUMBER_ID}/messages` for each one, using `messaging_product: "whatsapp"`, `type: "text"`, `text: { body: message }`.
- Sends all requests in parallel (`Promise.all`).
- For each number, after receiving Meta's response, **insert a row into the Supabase `sent_messages` table** (see schema below) recording: recipient number, message body, Meta's `message_id` (from response `messages[0].id`), raw response payload, and status `"pending"` (status will be updated later by the webhook status callback).
- Returns a JSON array of `{ to, status, data }` for each recipient so the frontend can show per-number success/failure.
- Handles and surfaces Meta API errors (e.g. recipient not in allowed test list, invalid number format) without crashing.

### Step 2 — `/api/webhook.js` (Serverless Function)

- **GET**: implements the Meta webhook verification handshake — checks `hub.mode === "subscribe"` and `hub.verify_token === process.env.VERIFY_TOKEN`, and if valid responds with the raw `hub.challenge` value (plain text, status 200). Otherwise responds 403.
- **POST**: parses the incoming webhook payload from `entry[0].changes[0].value`.
  - If `value.messages` is present: for each message, insert a row into the Supabase `incoming_messages` table (sender number, message type, message body/content, WhatsApp message id, raw payload, timestamp).
  - If `value.statuses` is present: for each status object, insert a row into the Supabase `message_status_updates` table (WhatsApp message id, status value, recipient number, timestamp, raw payload) AND update the matching row in `sent_messages` (match on `wa_message_id`) to set its `status` field to the new value.
  - Always responds with HTTP 200 quickly (Meta expects a fast ack; do inserts but don't block the response on anything non-essential).
- Wrap all Supabase calls in try/catch so a DB hiccup never causes the webhook to fail to acknowledge (log errors, still return 200).

### Step 3 — Supabase Auto-Connect on Page Load

- In `app.js`, import the Supabase JS client via CDN (`@supabase/supabase-js`).
- On `DOMContentLoaded`, initialize the Supabase client immediately using a **public anon key** (safe for client-side — never use the service role key in frontend code) read from a `window.__ENV__` object injected at build/deploy time, or hardcoded as the public anon key (it's meant to be public; row-level security protects the data).
- Immediately after connecting, subscribe to Postgres changes (Supabase Realtime) on `incoming_messages` and `message_status_updates` tables so new rows appear on the page instantly without refresh.
- Show a small connection status indicator on the page ("Connected to Supabase" / "Connection failed") so it's obvious the auto-connect worked.
- On initial load, also fetch the last ~50 rows from `incoming_messages` and `sent_messages` to populate the page with history, then let Realtime take over for anything new.

### Step 4 — Frontend UI (`index.html` + `style.css`)

Build a simple single page with:
- A form: textarea for the message, text input for comma-separated numbers (with helper text explaining format, e.g. `5511999999999, 5511888888888`), a "Send" button.
- A results panel showing the per-number send result (success/failure) after submitting.
- A live "Incoming Messages" panel that lists messages as they arrive via Realtime.
- A live "Status Updates" panel that lists status changes (sent → delivered → read) as they arrive, associated with the message they belong to.
- A "Sent Messages" history panel showing past sends with their current status.
- Clean, minimal styling — doesn't need to be fancy, just clearly organized into these sections.

### Step 5 — Supabase Schema (`supabase/schema.sql`)

Write a complete, ready-to-run SQL script (see the required schema below) including:
- Table creation for `sent_messages`, `incoming_messages`, `message_status_updates`.
- Appropriate indexes (on `wa_message_id`, `created_at`, phone number columns).
- Row Level Security enabled on all three tables, with a policy allowing `select` and `insert` for the `anon` role (since this is a test app, not production-secured — note this clearly as a comment in the SQL).
- Enable Realtime on all three tables (`ALTER PUBLICATION supabase_realtime ADD TABLE ...`).

### Step 6 — Environment Variables

Create `.env.example` documenting all required variables:
```
WHATSAPP_TOKEN=
PHONE_NUMBER_ID=
VERIFY_TOKEN=
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```
Note in comments which variables are safe for client-side exposure (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) and which must stay server-side only (`WHATSAPP_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY` if used, `VERIFY_TOKEN`).

### Step 7 — README.md

Include setup instructions covering:
1. Creating the Meta App + WhatsApp product + getting `WHATSAPP_TOKEN` and `PHONE_NUMBER_ID`.
2. Running the Supabase SQL script.
3. Setting environment variables in Vercel.
4. Deploying to Vercel.
5. Configuring the webhook URL + verify token in Meta's App Dashboard.
6. Subscribing to the `messages` webhook field.
7. How to test: sending a message, receiving a message, watching a status update flow through.

## Required Supabase Schema (implement exactly this structure)

```sql
-- sent_messages: every message this app sent out
create table if not exists sent_messages (
  id uuid primary key default gen_random_uuid(),
  wa_message_id text,
  recipient_number text not null,
  message_body text not null,
  status text default 'pending', -- pending | sent | delivered | read | failed
  raw_response jsonb,
  created_at timestamptz default now()
);

-- incoming_messages: messages received from WhatsApp users
create table if not exists incoming_messages (
  id uuid primary key default gen_random_uuid(),
  wa_message_id text,
  sender_number text not null,
  message_type text,
  message_body text,
  raw_payload jsonb,
  received_at timestamptz default now()
);

-- message_status_updates: status callbacks (sent/delivered/read/failed)
create table if not exists message_status_updates (
  id uuid primary key default gen_random_uuid(),
  wa_message_id text not null,
  recipient_number text,
  status text not null,
  raw_payload jsonb,
  received_at timestamptz default now()
);

-- Indexes
create index if not exists idx_sent_messages_wa_id on sent_messages(wa_message_id);
create index if not exists idx_incoming_messages_created on incoming_messages(received_at desc);
create index if not exists idx_status_updates_wa_id on message_status_updates(wa_message_id);

-- Row Level Security (test app only — tighten before production use)
alter table sent_messages enable row level security;
alter table incoming_messages enable row level security;
alter table message_status_updates enable row level security;

create policy "Allow anon read" on sent_messages for select using (true);
create policy "Allow anon insert" on sent_messages for insert with check (true);
create policy "Allow anon update" on sent_messages for update using (true);

create policy "Allow anon read" on incoming_messages for select using (true);
create policy "Allow anon insert" on incoming_messages for insert with check (true);

create policy "Allow anon read" on message_status_updates for select using (true);
create policy "Allow anon insert" on message_status_updates for insert with check (true);

-- Enable Realtime
alter publication supabase_realtime add table sent_messages;
alter publication supabase_realtime add table incoming_messages;
alter publication supabase_realtime add table message_status_updates;
```

## Acceptance Criteria

- [ ] Opening the deployed page auto-connects to Supabase and shows a visible "Connected" indicator, with no manual action needed.
- [ ] Submitting the form sends the message to every number in the list and shows per-number success/failure.
- [ ] A row appears in `sent_messages` immediately after sending.
- [ ] Sending a WhatsApp message to the test number triggers the webhook and the message appears live in the "Incoming Messages" panel without refreshing the page.
- [ ] Status changes (sent → delivered → read) appear live in the "Status Updates" panel and update the corresponding row's status in the "Sent Messages" panel.
- [ ] All secrets (`WHATSAPP_TOKEN`, `VERIFY_TOKEN`) stay server-side only — verify they never appear in any file under `/public` or in client-side JS bundles.
- [ ] `supabase/schema.sql` runs cleanly on a fresh Supabase project with no errors.
- [ ] `README.md` is complete enough that someone could deploy this from scratch following it.

## Design
You must implement a design with the same colors and styling inspired in the design showed in the images:
- /home/maicon_mares/Pictures/Screenshots/Screenshot from 2026-06-19 16-39-36.png
- /home/maicon_mares/Pictures/Screenshots/Screenshot from 2026-06-19 16-47-21.png

## Notes for Claude Code

- Use vanilla JS with `fetch` — no bundler, no npm build step needed for the frontend beyond what Vercel needs for the `/api` functions.
- Vercel serverless functions in `/api` are auto-detected — no extra config needed beyond a minimal `vercel.json` if required for routing.
- Keep the code simple and readable — this is a test/prototype tool, not a production system. Prioritize clarity over abstraction.
- Free-form WhatsApp text messages only work within a 24-hour customer service window or to numbers pre-approved as test recipients. If Meta returns an error for this reason, surface the raw error message to the user in the results panel rather than swallowing it.