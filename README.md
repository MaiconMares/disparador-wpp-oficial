# Gestão Fitness Brasil — Disparador WhatsApp (Cloud API + Evolution API)

Single-page app with two tabs — **API Oficial WhatsApp** (Meta Cloud API) and **Evolution API** (WhatsApp não-oficial) — to send WhatsApp messages, receive incoming messages through a webhook, and watch delivery status updates, all in real time via Supabase Realtime.

## Stack

| Layer | Technology |
|---|---|
| Frontend | Plain HTML + CSS + Vanilla JS (no build step) |
| Backend | Vercel Serverless Functions (Node.js 20) |
| Database | Supabase (Postgres + Realtime) |
| API | Meta WhatsApp Cloud API v25.0 |

---

## Setup Guide

### 1 — Create a Meta App with WhatsApp

1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps** → **Create App**.
2. Choose **Business** type, fill in the name and contact email.
3. On the app dashboard, click **Add Product** → find **WhatsApp** → click **Set Up**.
4. Under **WhatsApp → API Setup** you will find:
   - **Phone Number ID** → copy it as `PHONE_NUMBER_ID`
   - **Temporary Access Token** (valid 24 h) OR generate a **System User Token** for a permanent one → copy as `WHATSAPP_TOKEN`
5. Add your own number (or test recipients) under **To** in the test-message panel.

> Free-form text messages only work to numbers that are registered as test recipients **or** within a 24-hour customer-initiated conversation window. If Meta returns an error, the app will display the raw error message in the results panel.

#### Sending approved template messages

The **API Oficial WhatsApp** tab also supports sending approved message templates (the ones listed under **Gestor do WhatsApp → Modelos de mensagem**), which can be sent to any number regardless of the 24-hour window:

1. Fill in **WhatsApp Business Account ID** (found in the Meta Business Manager URL or **WhatsApp → API Setup**) alongside the Phone Number ID and Bearer Token.
2. Switch to **Mensagem de Modelo (Template)**, click **Buscar Modelos** to list your approved templates, then pick one.
3. Fill in any `{{variável}}` fields detected in the header/body — both numbered (`{{1}}`) and named (`{{customer_name}}`) placeholders are supported — and check the live preview.
4. If the template has a media header (image/video/document), paste a public URL for it.
5. Send as usual — the resolved preview text is stored in **Histórico de Envios** for reference.

---

### 2 — Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) → **New Project**.
2. Once the project is ready, open **SQL Editor** and run:
   - **Fresh project:** the contents of `supabase/schema.sql`.
   - **Existing project already running the old schema:** `supabase/auth-migration.sql`
     (adds multi-user login, per-user RLS, creates the first account, and links
     **all existing data** to that account).
3. From **Project Settings → API** copy:
   - **Project URL** → `SUPABASE_URL`
   - **anon / public** key → `SUPABASE_ANON_KEY`
   - **service_role** key → `SUPABASE_SERVICE_ROLE_KEY`

---

### Login (multi-user)

Every row belongs to a user (`user_id → auth.users`) and Row Level Security lets
each account see **only its own** sent/received messages and status updates. The
app shows a login screen until you sign in; the session is kept in the browser.

- **Create accounts** in the Supabase dashboard → **Authentication → Users → Add user**
  (set "Auto Confirm User"). There is no public sign-up.
- The API routes (`/api/send`, `/api/evolution-send`, …) require the caller's
  Supabase access token and stamp `user_id` on every insert.
- Webhooks have no session, so they attribute incoming messages by channel:
  `phone_number_id` (Cloud API) or instance name (Evolution) → owner, using the
  `whatsapp_numbers` / `evolution_instances` maps that the send routes populate.
  Send at least one message (or open the Evolution tab so the status check runs)
  from an account before its inbound messages can be attributed.

---

### 3 — Deploy to Vercel

1. Push this repository to GitHub (or import directly via the Vercel UI).
2. In Vercel, go to **Settings → Environment Variables** and add all six variables:

   | Variable | Visibility |
   |---|---|
   | `WHATSAPP_TOKEN` | Server only |
   | `PHONE_NUMBER_ID` | Server only |
   | `VERIFY_TOKEN` | Server only (any random string you choose) |
   | `SUPABASE_URL` | All environments |
   | `SUPABASE_ANON_KEY` | All environments |
   | `SUPABASE_SERVICE_ROLE_KEY` | Server only |

3. Click **Deploy**. Vercel auto-detects the `/api` functions and serves `/public` as static files.

---

### 4 — Configure the Meta Webhook

1. In the Meta App Dashboard → **WhatsApp → Configuration**.
2. Under **Webhook**, click **Edit**:
   - **Callback URL**: `https://<your-vercel-domain>/api/webhook`
   - **Verify Token**: the same value you set as `VERIFY_TOKEN`
3. Click **Verify and Save**. The GET handshake is handled by `/api/webhook.js`.
4. Under **Webhook Fields**, subscribe to **`messages`** (this covers both incoming messages and status callbacks).

---

### 5 — Test the Flow

| Action | What to observe |
|---|---|
| Open the app | "Conectado ao Supabase" badge appears in the sidebar |
| Fill in a message + number, click Send | Per-number success/failure shown immediately; row appears in **Histórico de Envios** |
| WhatsApp delivers the message | Status badge updates: `Pendente → Enviado → Entregue → Lido` in real time |
| Send a message FROM your phone TO the test number | Message appears live in **Mensagens Recebidas** |

---

### 6 — Evolution API Tab (WhatsApp não-oficial)

The **Evolution API** tab talks to your own Evolution API server (self-hosted or a provider's instance) — see the [official docs](https://docs.evolutionfoundation.com.br/evolution-api/send-text-message). Unlike the Cloud API tab, no server-side env vars are required: the base URL, API Key, instance name and sender number are entered directly in the panel and stored only in your browser's `localStorage`.

1. Fill in **URL Base da API** (e.g. `https://sua-evolution-api.com`), **API Key**, **Nome da Instância** and **Número do Remetente**, then click **Salvar Credenciais**.
2. Check the **Status da Instância** card — it must show **Conectado** before sending. If it shows **Desconectado**, connect the instance to WhatsApp first (scan the QR code through your Evolution API server/manager).
3. To receive incoming messages and delivery/read status updates, configure a webhook on your Evolution instance (`POST /webhook/set/{instanceName}`) pointing to:
   - **URL**: `https://<your-vercel-domain>/api/evolution-webhook`
   - **Events**: at least `MESSAGES_UPSERT` and `MESSAGES_UPDATE`
4. The **Regras Anti-Bloqueio** panel lets you configure randomized delays between sends, recipient shuffling, invisible text variation, and spintax (`{opção 1|opção 2}`) inside the message — all aimed at reducing the risk of the sending number being blocked when messaging many recipients.

---

## Project Structure

```
/public              Static frontend (HTML, CSS, JS) — two tabs, same SPA
/api
  config.js           Returns public Supabase keys to the frontend
  send.js              POST — sends text or template messages via Meta Cloud API
  templates.js         POST — lists approved message templates from Meta
  webhook.js           GET  — Meta verification handshake
                       POST — handles incoming messages + status updates
  evolution-status.js  POST — checks Evolution instance connection state
  evolution-send.js    POST — sends one message via Evolution API + logs to Supabase
  evolution-webhook.js POST — handles Evolution incoming messages + status updates
  _evolution-lib.js    Shared helpers for the evolution-* routes (not a route itself)
/supabase
  schema.sql     Complete DB schema with RLS + Realtime (Cloud API + Evolution tables)
.env.example     All required environment variables documented
vercel.json      Vercel function runtime config
package.json     Node dependencies for /api functions
```

## Security Notes

- `WHATSAPP_TOKEN`, `VERIFY_TOKEN`, and `SUPABASE_SERVICE_ROLE_KEY` are **never** sent to the browser.
- `SUPABASE_URL` and `SUPABASE_ANON_KEY` are intentionally public; Row Level Security in Supabase protects the data.
- For production use, add user authentication and tighten the RLS policies to restrict inserts to server-side roles only.
