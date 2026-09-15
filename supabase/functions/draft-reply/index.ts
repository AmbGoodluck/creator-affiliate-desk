// draft-reply: for creators who replied, ask Claude to draft a human, in-context response
// that follows Osman's rules (no em dashes, no AI tells, nothing invented). Stores it for approval.
// It never sends. Approval + sending happens in the dashboard and send-due.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-3-5-sonnet-latest";

const db = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

const firstName = (n: string) => (n && n !== "there") ? n.split(" ")[0] : "";
function buildFirst(c: any, s: any) {
  const fn = firstName(c.name);
  const subject = c.subject_override ? c.subject_override : (fn ? String(s.subject_named).replaceAll("{name}", fn) : s.subject_generic);
  const body = c.email_override ? c.email_override
    : (String(s.body_template).replaceAll("{name}", c.name || "there").replaceAll("{compliment}", c.compliment || "").replaceAll("{problem}", c.problem || "").replaceAll("{fromName}", s.from_name || "") + "\n\n" + s.footer + "\n" + s.address);
  return { subject, body };
}

const SYSTEM = [
  "You are drafting a short email reply on behalf of Osman, a solo founder recruiting personal finance creators as 50 percent affiliate partners for a digital product he is building (working name Money Reset).",
  "Hard rules:",
  "- Sound like a real person. Warm, direct, concise. Match the creator's tone.",
  "- Do not use em dashes. Do not use en dashes. Use plain sentences and commas.",
  "- No AI writing tells: no 'I hope this finds you well', no 'delve', no 'excited to', no rule-of-three padding, no bullet lists unless the creator asked for specifics.",
  "- Never invent facts, numbers, features, launch dates, payouts, or commitments beyond: the product is still being built, the split is 50 percent, Osman handles product and delivery, the creator just shares it.",
  "- Answer what they actually asked. If they asked a question you cannot answer truthfully, say Osman will follow up with specifics rather than making something up.",
  "- 60 to 130 words. Sign off as Osman. Output only the email body, no subject, no preamble.",
].join("\n");

async function claude(userText: string) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 700, system: SYSTEM, messages: [{ role: "user", content: userText }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`anthropic: ${JSON.stringify(j).slice(0, 300)}`);
  return (j?.content?.[0]?.text || "").trim();
}

Deno.serve(async () => {
  if (!ANTHROPIC_API_KEY) return json({ skipped: "Set ANTHROPIC_API_KEY secret to enable reply drafting." });
  const { data: s } = await db.from("outreach_settings").select("*").eq("id", 1).single();
  const { data: cs } = await db.from("outreach_creators").select("*")
    .eq("archived", false).eq("status", "Replied").eq("reply_status", "needs_draft");

  const out = { drafted: 0, errors: [] as string[] };
  for (const c of (cs || [])) {
    try {
      const original = buildFirst(c, s).body;
      const context = [
        `Creator handle: @${c.handle}. Their audience: ${c.audience_problem || ""}`,
        `The email Osman originally sent them:\n"""\n${original}\n"""`,
        `Their reply:\n"""\n${c.reply_text || ""}\n"""`,
        `Draft Osman's next reply.`,
      ].join("\n\n");
      const draft = await claude(context);
      if (draft) {
        await db.from("outreach_creators").update({ reply_draft: draft, reply_status: "drafted" }).eq("id", c.id);
        out.drafted++;
      }
    } catch (e) {
      out.errors.push(`${c.handle}: ${String(e).slice(0, 160)}`);
    }
  }
  return json(out);
});
