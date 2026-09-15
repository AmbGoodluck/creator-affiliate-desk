// send-due: the outbound engine. Runs on a schedule (pg_cron).
// - sends the first email to creators you approved (approve-first)
// - sends the next scheduled follow-up when due (max reached => archive as ghost)
// - sends an approved reply back to a creator
// Uses the auto-injected service role to bypass RLS. Sends via Composio Gmail.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const COMPOSIO_API_KEY = Deno.env.get("COMPOSIO_API_KEY") || "";
const GMAIL_ACCOUNT_ID = Deno.env.get("GMAIL_CONNECTED_ACCOUNT_ID") || "gmail_diol-itemy";
const COMPOSIO_BASE = Deno.env.get("COMPOSIO_BASE_URL") || "https://backend.composio.dev/api/v3";

const db = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

// ---- pure helpers (mirror of tests/core.mjs) ----
const firstName = (n: string) => (n && n !== "there") ? n.split(" ")[0] : "";
function personalize(text: string, c: any, s: any) {
  const name = c.name || "there";
  return String(text || "")
    .replaceAll("{name}", name)
    .replaceAll("{compliment}", c.compliment || "")
    .replaceAll("{problem}", c.problem || "")
    .replaceAll("{fromName}", s.from_name || "");
}
function buildFirst(c: any, s: any) {
  const fn = firstName(c.name);
  const subject = c.subject_override ? c.subject_override
    : (fn ? String(s.subject_named).replaceAll("{name}", fn) : s.subject_generic);
  const body = c.email_override ? c.email_override
    : (personalize(s.body_template, c, s) + "\n\n" + s.footer + "\n" + s.address);
  return { subject, body };
}
function buildFollowup(c: any, s: any, tpl: any) {
  return { subject: personalize(tpl.subject, c, s), body: personalize(tpl.body, c, s) + "\n\n" + s.footer + "\n" + s.address };
}
const addDays = (d: Date, days: number) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + Number(days)); return x; };

// ---- Composio Gmail send. Returns { id, threadId }. ----
async function composio(tool: string, args: Record<string, unknown>) {
  const r = await fetch(`${COMPOSIO_BASE}/tools/execute/${tool}`, {
    method: "POST",
    headers: { "x-api-key": COMPOSIO_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ connected_account_id: GMAIL_ACCOUNT_ID, arguments: args }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error || j?.successful === false) {
    throw new Error(`composio ${tool}: ${JSON.stringify(j).slice(0, 300)}`);
  }
  const d = j?.data?.response_data ?? j?.data ?? {};
  return { id: d.id ?? d.messageId ?? null, threadId: d.threadId ?? d.thread_id ?? d.id ?? null };
}
async function sendEmail(to: string, subject: string, body: string) {
  return await composio("GMAIL_SEND_EMAIL", { recipient_email: to, subject, body, is_html: false });
}

async function logMsg(c: any, direction: string, kind: string, subject: string, body: string, gmailId: string | null) {
  await db.from("outreach_messages").insert({ creator_id: c.id, handle: c.handle, direction, kind, subject, body, gmail_message_id: gmailId });
}
async function archive(c: any, reason: string, lostStatus = true) {
  await db.from("outreach_archive").insert({ id: c.id, handle: c.handle, data: c, reason });
  if (c.email) await db.from("outreach_suppression").upsert({ email: c.email, handle: c.handle, reason }, { onConflict: "email" });
  await db.from("outreach_creators").update({ archived: true, status: lostStatus ? "Lost" : c.status }).eq("id", c.id);
}

Deno.serve(async () => {
  if (!COMPOSIO_API_KEY) return json({ skipped: "Set COMPOSIO_API_KEY secret to enable sending." });
  const now = new Date();

  const { data: s } = await db.from("outreach_settings").select("*").eq("id", 1).single();
  const { data: fus } = await db.from("outreach_followup_templates").select("*").eq("active", true).order("step");
  const { data: supp } = await db.from("outreach_suppression").select("email");
  const suppressed = new Set((supp || []).map((x: any) => (x.email || "").toLowerCase()));

  const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
  const { count: sentToday } = await db.from("outreach_messages").select("*", { count: "exact", head: true })
    .eq("direction", "out").gte("created_at", todayStart.toISOString());
  let budget = (s.daily_send_cap || 25) - (sentToday || 0);

  const { data: cs } = await db.from("outreach_creators").select("*").eq("archived", false).in("status", ["Approved", "Sent", "Replied"]);
  const out = { first: 0, followup: 0, replies_sent: 0, archived: 0, skipped: 0, errors: [] as string[] };

  for (const c of (cs || [])) {
    try {
      const email = (c.email || "").trim();

      // 1) approved reply waiting to go out
      if (c.reply_status === "approved" && (c.reply_draft || "").trim() && email) {
        if (budget <= 0) break;
        const subject = "Re: " + buildFirst(c, s).subject;
        const res = await sendEmail(email, subject, c.reply_draft);
        await db.from("outreach_creators").update({ reply_status: "sent", last_touch_at: now.toISOString() }).eq("id", c.id);
        await logMsg(c, "out", "reply", subject, c.reply_draft, res.id);
        budget--; out.replies_sent++;
        continue;
      }

      // 2) first email (approve-first)
      if (!c.first_sent_at && c.first_email_approved && c.status === "Approved") {
        if (!email || suppressed.has(email.toLowerCase())) { out.skipped++; continue; }
        if (budget <= 0) break;
        const { subject, body } = buildFirst(c, s);
        const res = await sendEmail(email, subject, body);
        await db.from("outreach_creators").update({
          status: "Sent", first_sent_at: now.toISOString(), last_touch_at: now.toISOString(),
          followups_sent: 0, next_followup_at: fus?.[0] ? addDays(now, fus[0].delay_days).toISOString() : null,
          gmail_thread_id: res.threadId,
        }).eq("id", c.id);
        await logMsg(c, "out", "first", subject, body, res.id);
        budget--; out.first++;
        continue;
      }

      // 3) follow-ups + ghost archive
      if (c.first_sent_at && c.status === "Sent" && !c.reply_at) {
        const max = s.followup_max || 5;
        const due = c.next_followup_at && new Date(c.next_followup_at) <= now;
        if (due && c.followups_sent < max) {
          if (!email || suppressed.has(email.toLowerCase())) { out.skipped++; continue; }
          if (budget <= 0) break;
          const step = c.followups_sent + 1;
          const tpl = (fus || []).find((f: any) => f.step === step);
          if (tpl) {
            const { subject, body } = buildFollowup(c, s, tpl);
            const res = await sendEmail(email, subject, body);
            const nextTpl = (fus || []).find((f: any) => f.step === step + 1);
            await db.from("outreach_creators").update({
              followups_sent: step, last_touch_at: now.toISOString(),
              next_followup_at: nextTpl ? addDays(now, nextTpl.delay_days).toISOString() : addDays(now, s.followup_window_days || 14).toISOString(),
            }).eq("id", c.id);
            await logMsg(c, "out", "followup_" + step, subject, body, res.id);
            budget--; out.followup++;
            continue;
          }
        }
        const windowMs = (s.followup_window_days || 14) * 86400000;
        if (c.followups_sent >= max && (now.getTime() - new Date(c.first_sent_at).getTime()) > windowMs) {
          await archive(c, "ghosted", true); out.archived++;
        }
      }
    } catch (e) {
      out.errors.push(`${c.handle}: ${String(e).slice(0, 160)}`);
    }
  }
  return json(out);
});
