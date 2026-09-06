# Supabase Keepalive — Cloudflare Worker

Prevent free-tier **Supabase** projects from being **paused due to inactivity**.

A **Cloudflare Worker** with a **PIN-protected web dashboard** where you can register multiple Supabase projects (URL + anon key). A daily **cron trigger** performs a dedicated **read → delete → insert** inside a dedicated dummy table in each project, generating real database activity — without touching your existing tables or data.

## ✨ Features

- 🔐 PIN-protected dashboard (HMAC-signed session cookie)
- ➕ Add unlimited Supabase projects from a nice web UI
- 💾 Projects stored securely in **Cloudflare KV**
- ⏰ Daily **Cloudflare cron** keepalive (`0 9 * * *`)
- 🛡️ Dedicated dummy table `cf_keep_alive` + dedicated SQL function — your real data is never touched
- 🧪 Per-project **Test** button and manual **Run all now**
- 🧹 Only uses the `anon` key — never `service_role`

## 🧠 How it works

1. You run `sql/setup.sql` once in each Supabase project. It creates:
   - a dummy table `public.cf_keep_alive`
   - a function `public.cf_keepalive_ping(secret)` that reads, deletes, and inserts a random row in that table only.
2. You deploy `worker.js` to Cloudflare Workers, bind a KV namespace as `PROJECTS_KV`, and add a cron trigger.
3. You open the Worker URL, enter your PIN, and add your Supabase project URLs + anon keys.
4. Every day the cron calls the function in every registered project → database activity → project stays awake.

## 🚀 Setup

1. **Supabase:** open SQL Editor in your project and run `sql/setup.sql`. Repeat for every project.
2. **Cloudflare:** create a Worker, paste `worker.js`, bind a KV namespace named `PROJECTS_KV`.
3. Add a **cron trigger**: `0 9 * * *` (daily, UTC).
4. (Recommended) Set secrets: `UI_PIN`, `KEEPALIVE_SECRET`, `COOKIE_SECRET`.
5. Open the Worker URL, enter the PIN, add your projects, click **Test**.

If you prefer Wrangler, copy `wrangler.toml.example` to `wrangler.toml` and fill in your KV namespace ID.

## 🔐 Security notes

- Supabase URLs and anon keys live only in your private Cloudflare KV — never in this repo.
- The keepalive secret must match between the Worker and the SQL function.
- The dummy table has RLS enabled and is only writable through the secret-protected function.
- Change all `YOUR_...` placeholders before deploying.

## 🧩 Keywords

supabase keep alive, supabase free plan pause, prevent supabase pause, cloudflare worker cron, serverless keepalive, postgres heartbeat, supabase inactive project, wake supabase project.

## 📄 License

MIT
