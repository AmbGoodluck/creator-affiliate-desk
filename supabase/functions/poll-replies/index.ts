// poll-replies: pulls recent inbound Gmail, matches sender to a creator we emailed,
// records the reply, pauses their follow-ups, and flags it for a Claude-drafted response.
// Reply detection is best-effort; the dashboard also lets you paste a reply by hand.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const COMPOSIO_API_KEY = Deno.env.get("COMPOSIO_API_KEY") || "";
const GMAIL_ACCOUNT_ID = Deno.env.get("GMAIL_CONNECTED_ACCOUNT_ID") || "gmail_diol-itemy";
const COMPOSIO_BASE = Deno.env.get("COMPOSIO_BASE_URL") || "https://backend.composio.dev/api/v3";

const db = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

async function composio(tool: string, args: Record<string, unknown>) {
  const r = await fetch(`${COMPOSIO_BASE}/tools/execute/${tool}`, {
    method: "POST",
    headers: { "x-api-key": COMPOSIO_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ connected_account_id: GMAIL_ACCOUNT_ID, arguments: args }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(`composio ${tool}: ${JSON.stringify(j).slice(0, 300)}`);
  return j?.data?.response_data ?? j?.data ?? {};
}

// Best-effort extraction across possible Composio Gmail fetch shapes.
function extractMessages(d: any): any[] {
  return d?.messages || d?.emails || d?.data?.messages || d?.threads || [];
}
function senderEmail(m: any): string {
  const raw = m?.from || m?.sender || m?.payload?.headers?.find?.((h: any) => h.name?.toLowerCase() === "from")?.value || "";
  const match = String(raw).match(/[^<\s]+@[^>\s]+/);
  return match ? match[0].toLowerCase() : "";
}
function bodyText(m: any): string {
  return String(m?.snippet || m?.messageText || m?.body || m?.preview || "").slice(0, 2000);
}
function sentAtMs(m: any): number {
  const v = m?.internalDate || m?.messageTimestamp || m?.date;
  const n = Number(v);
  if (!Number.isNaN(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(String(v || ""));
  return Number.isNaN(t) ? Date.now() : t;
}

Deno.serve(async () => {
  if (!COMPOSIO_API_KEY) return json({ skipped: "Set COMPOSIO_API_KEY secret to enable reply polling." });

  const { data: cs } = await db.from("outreach_creators").select("*")
    .eq("archived", false).eq("status", "Sent").not("first_sent_at", "is", null);
  const byEmail = new Map<string, any>();
  for (const c of (cs || [])) if (c.email) byEmail.set(c.email.toLowerCase(), c);
  if (byEmail.size === 0) return json({ checked: 0, replies: 0 });

  let messages: any[] = [];
  try {
    const d = await composio("GMAIL_FETCH_EMAILS", { query: "newer_than:20d -in:sent -in:chats -in:drafts", max_results: 60 });
    messages = extractMessages(d);
  } catch (e) {
    return json({ error: String(e).slice(0, 200), note: "Confirm the Gmail fetch tool slug for your Composio version." });
  }

  const out = { checked: byEmail.size, scanned: messages.length, replies: 0, errors: [] as string[] };
  for (const m of messages) {
    try {
      const from = senderEmail(m);
      const c = byEmail.get(from);
      if (!c) continue;
      if (sentAtMs(m) <= new Date(c.first_sent_at).getTime()) continue; // older than our first email
      const text = bodyText(m);
      await db.from("outreach_creators").update({
        status: "Replied", reply_text: text, reply_at: new Date(sentAtMs(m)).toISOString(),
        reply_status: "needs_draft", next_followup_at: null,
      }).eq("id", c.id);
      await db.from("outreach_messages").insert({ creator_id: c.id, handle: c.handle, direction: "in", kind: "reply", body: text, gmail_message_id: m?.id || null });
      byEmail.delete(from);
      out.replies++;
    } catch (e) {
      out.errors.push(String(e).slice(0, 160));
    }
  }
  return json(out);
});
