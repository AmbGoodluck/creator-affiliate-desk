# Creator Affiliate Desk

A personal outreach engine to recruit personal-finance Instagram creators (25k–100k followers) as founding affiliates at a 50% revenue share for a digital product (working name: Money Reset).

It sources into a database, sends a first email you approve, auto-runs follow-ups, detects replies, drafts human responses for you to approve, and archives anyone who says no or ghosts after 5 follow-ups in 2 weeks.

## Architecture

| Layer | Tech | What it does |
|---|---|---|
| Database | Supabase Postgres (project `aiyfpbyrvpgtuuenrfph`, `outreach_*` tables in `public`) | Source of truth: prospects, accepted, suppression, messages, settings, follow-up templates. RLS locks every row to your email. |
| Dashboard | Static site on **Cloudflare Pages** (`web/index.html`) | Filter, edit drafts, approve/decline, mark won, manage replies. Talks to Supabase via `supabase-js` + magic-link auth. |
| Engine | Supabase **Edge Functions** + **pg_cron** | `send-due` (first + follow-ups + ghost-archive), `poll-replies` (detect inbound), `draft-reply` (Claude drafts responses). |
| Email | **Composio** Gmail (already connected to your account) | Sends and reads mail through `GMAIL_SEND_EMAIL` / Gmail fetch. |
| Reply drafting | **Anthropic API** | Writes human, in-context replies. No em dashes, nothing invented. |

## Status: what is already done

- ✅ Schema, RLS, triggers, and 30-day purge applied to Supabase.
- ✅ 29 creators, 5 follow-up templates, and settings seeded.
- ✅ Dashboard, edge functions, cron, and tests written (this repo).
- ✅ Tests pass (`npm test`).

## What is left (needs your accounts — 4 steps)

Install the Supabase CLI first: `npm i -g supabase` then `supabase login`.

### 1. Deploy the three edge functions
```bash
supabase functions deploy send-due     --project-ref aiyfpbyrvpgtuuenrfph
supabase functions deploy poll-replies --project-ref aiyfpbyrvpgtuuenrfph
supabase functions deploy draft-reply  --project-ref aiyfpbyrvpgtuuenrfph
```

### 2. Set the two secrets (you paste these; they are never stored in this repo)
```bash
supabase secrets set COMPOSIO_API_KEY=your_composio_api_key --project-ref aiyfpbyrvpgtuuenrfph
supabase secrets set ANTHROPIC_API_KEY=your_anthropic_api_key --project-ref aiyfpbyrvpgtuuenrfph
# optional overrides:
# supabase secrets set GMAIL_CONNECTED_ACCOUNT_ID=gmail_diol-itemy --project-ref aiyfpbyrvpgtuuenrfph
# supabase secrets set ANTHROPIC_MODEL=claude-3-5-sonnet-latest --project-ref aiyfpbyrvpgtuuenrfph
```
- Composio API key: https://app.composio.dev → Settings → API keys.
- Anthropic API key: https://console.anthropic.com → API keys.

### 3. Turn on the schedule
Run `supabase/cron.sql` once (Supabase dashboard → SQL editor), after the functions are deployed.

### 4. Publish the dashboard to Cloudflare Pages
- Push this repo to GitHub, then in Cloudflare → Pages → Create → connect the repo.
- Build command: none. Output directory: `web`.
- Or drag-and-drop the `web/` folder in the Pages dashboard.
- After first sign-in, add your production URL to Supabase → Auth → URL Configuration → Redirect URLs.

## How the pipeline works

1. **New** → you open a creator, add their email, edit the draft, and hit **Approve & queue first email** (status → **Approved**). Approve-first: nothing sends until you do this.
2. `send-due` sends the first email (status → **Sent**) and schedules follow-up #1.
3. Follow-ups #1–5 go out on the template delays (3,3,3,3,2 days) unless they reply.
4. **Reply** detected → follow-ups pause, `draft-reply` writes a suggested response, you approve it in the **Replies** tab, `send-due` sends it.
5. **No / ghost:** decline sets status **Declined** → suppressed + archived. 5 follow-ups past 14 days with no reply → auto-archived as ghosted. Suppressed emails are never contacted again. Archived rows purge after 30 days.
6. **Won** → moves to the **Accepted** table.

## Config that lives in the code (safe to commit)
- Supabase URL + publishable key in `web/index.html` (public by design; RLS protects the data).
- The legacy anon JWT in `cron.sql` (public; only satisfies `verify_jwt`).
Secrets (Composio, Anthropic) are **never** in the repo — they live only in Supabase secrets.

## Notes and known edges
- Reply detection (`poll-replies`) uses `GMAIL_FETCH_EMAILS`; confirm that slug for your Composio version if replies do not appear, and use the dashboard to paste a reply by hand as a fallback.
- Follow-ups currently send as new emails with a matching subject. To thread them into the original conversation, switch `sendEmail` to `GMAIL_REPLY_TO_THREAD` using `gmail_thread_id`.
- Cold email compliance: fill your real mailing address in Settings, keep the opt-out line, and respect the daily send cap.

## Tests
```bash
npm test
```
Covers email assembly, placeholder filling, the no-em-dash rule, follow-up due timing, and the ghost-archive rule.
