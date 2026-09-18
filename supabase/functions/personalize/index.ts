// personalize: per-creator outreach grounded in real circumstance + a verbatim follower quote.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APIFY_TOKEN = Deno.env.get("APIFY_TOKEN") || "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5";

const NL = String.fromCharCode(10);
const EM = String.fromCharCode(8212), EN = String.fromCharCode(8211);
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const db = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function norm(s: string): string {
  let out = "";
  const t = String(s || "").toLowerCase();
  for (const ch of t) out += ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) ? ch : " ";
  return out.split(" ").filter(Boolean).join(" ");
}
const firstEmail = (s: string) => (String(s || "").match(EMAIL_RE) || [null])[0];

async function apify(actor: string, input: unknown, timeoutS = 70) {
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=${timeoutS}`;
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const t = await r.text();
  if (!r.ok) throw new Error(`apify ${actor} ${r.status}: ${t.slice(0, 140)}`);
  try { return JSON.parse(t); } catch { return []; }
}

let RESOLVED_MODEL = MODEL;
async function pickModel(): Promise<string> {
  try {
    const r = await fetch("https://api.anthropic.com/v1/models?limit=100", { headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" } });
    const j = await r.json();
    const ids: string[] = (j.data || []).map((m: any) => m.id);
    return ids.find((id) => id.includes("sonnet")) || ids.find((id) => id.includes("haiku")) || ids[0] || MODEL;
  } catch { return MODEL; }
}
async function anthropicCall(model: string, prompt: string) {
  return await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 1200, messages: [{ role: "user", content: prompt }] }),
  });
}
function textOf(j: any): string {
  const blocks = Array.isArray(j?.content) ? j.content : [];
  return blocks.map((b: any) => (b && typeof b.text === "string") ? b.text : "").join("").trim();
}
async function claude(prompt: string): Promise<string> {
  let r = await anthropicCall(RESOLVED_MODEL, prompt);
  if (r.status === 404) { RESOLVED_MODEL = await pickModel(); r = await anthropicCall(RESOLVED_MODEL, prompt); }
  const j = await r.json();
  if (!r.ok) throw new Error(`anthropic ${r.status} (model ${RESOLVED_MODEL}): ${JSON.stringify(j).slice(0, 140)}`);
  return textOf(j);
}
async function claudeRaw(prompt: string): Promise<any> {
  let r = await anthropicCall(RESOLVED_MODEL, prompt);
  if (r.status === 404) { RESOLVED_MODEL = await pickModel(); r = await anthropicCall(RESOLVED_MODEL, prompt); }
  const j = await r.json();
  return { status: r.status, model: RESOLVED_MODEL, stop_reason: j?.stop_reason, types: (Array.isArray(j?.content) ? j.content.map((b: any) => b?.type) : null), text: textOf(j).slice(0, 1200), raw: JSON.stringify(j).slice(0, 800) };
}

function extractJson(s: string): any {
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("no json");
  return JSON.parse(s.slice(a, b + 1));
}

function buildPrompt(c: any, s: any, captions: string[], comments: string[], stern: boolean): string {
  const product = s.product || "a digital product";
  const fromName = s.from_name || "Osman";
  const capLines = captions.map((x) => "  - " + x.slice(0, 180)).join(NL) || "  (none)";
  const comLines = comments.map((x, i) => "  " + (i + 1) + ". " + x.slice(0, 200)).join(NL) || "  (none)";
  const sternLine = stern ? "PREVIOUS ATTEMPT FAILED: copy the quote EXACTLY from a comment above, word for word, and include that exact quote inside the body." : "";
  return [
    "You write ONE cold outreach message (Instagram DM style) for a real Instagram creator. It must sound like a human wrote it, not AI.",
    "",
    "CREATOR",
    "- handle: @" + c.handle,
    "- niche: " + (c.niche || "unknown"),
    "- followers: " + (c.followers_num || "?"),
    "- bio: " + (c.evidence || "(none)"),
    "- recent captions:",
    capLines,
    "",
    "THEIR FOLLOWERS ARE SAYING (real comments):",
    comLines,
    "",
    "OFFER (from " + fromName + "): " + fromName + " is building " + product + ". He is recruiting a few creators as founding affiliates at a 50 percent revenue share. The creator just shares it with their audience; " + fromName + " builds the product and handles delivery and support. The creator builds nothing. This is NOT an investment and asks for NO money from the creator.",
    "",
    "WRITE THE MESSAGE SO THAT:",
    "1. It is specific to THIS creator, drawn from their bio and captions (name what they actually do in their own niche, never finance unless they are a finance creator).",
    "2. It quotes ONE real follower comment VERBATIM (copy it exactly from the list) and connects that audience pain point or demand to why the 50 percent affiliate product fits them.",
    "3. Human voice, warm, direct, concise (max about 130 words). NO em dashes. Avoid AI cliches and filler. Never mention investment or ask for money. Do not invent facts, numbers, or names.",
    "4. End with a soft question and sign off as " + fromName + ".",
    sternLine,
    "",
    "Return ONLY strict JSON, no prose, with exactly these keys: subject, body, quote, pain.",
  ].join(NL);
}

async function personalizeOne(c: any, s: any) {
  const res: any = { handle: c.handle, status: "", email: c.email || null };
  const captions: string[] = [];
  const postUrls: string[] = [];
  try {
    const prof = await apify("apify~instagram-profile-scraper", { usernames: [c.handle] }, 60);
    const p = (prof as any[])[0] || {};
    if (!res.email) res.email = p.businessEmail || p.publicEmail || firstEmail(p.biography) || firstEmail(c.evidence) || null;
    const posts = Array.isArray(p.latestPosts) ? p.latestPosts : [];
    for (const po of posts.slice(0, 3)) {
      if (po.caption) captions.push(String(po.caption));
      const u = po.url || (po.shortCode ? "https://www.instagram.com/p/" + po.shortCode + "/" : null);
      if (u) postUrls.push(u);
    }
  } catch (e) { res.note = "profile: " + String(e).slice(0, 100); }

  let comments: string[] = [];
  try {
    for (const u of postUrls.slice(0, 2)) {
      if (comments.length >= 30) break;
      const cm = await apify("apify~instagram-comment-scraper", { directUrls: [u], resultsLimit: 25 }, 60);
      for (const it of (cm as any[]) || []) {
        const txt = String(it.text || "").trim();
        if (txt && txt.length >= 8 && String(it.ownerUsername || "").toLowerCase() !== c.handle.toLowerCase()) comments.push(txt);
      }
    }
  } catch (e) { res.note = (res.note ? res.note + "; " : "") + "comments: " + String(e).slice(0, 100); }
  comments = [...new Set(comments)].slice(0, 40);

  if (!comments.length) {
    await db.from("outreach_creators").update({ email: res.email, personalization_status: "needs_review", personalized_at: new Date().toISOString() }).eq("id", c.id);
    res.status = "needs_review"; res.reason = "no follower comments to quote";
    return res;
  }

  const blob = norm(comments.join("  ||  "));
  let ok = false, out: any = null;
  for (let attempt = 0; attempt < 2 && !ok; attempt++) {
    try {
      const raw = await claude(buildPrompt(c, s, captions, comments, attempt > 0));
      out = extractJson(raw);
      const q = norm(out.quote || "");
      const inComments = q.length >= 10 && blob.includes(q);
      const inBody = q.length >= 10 && norm(out.body || "").includes(q);
      const bodyStr = String(out.body || "");
      const noEmDash = bodyStr.indexOf(EM) < 0 && bodyStr.indexOf(EN) < 0;
      ok = !!(out.subject && out.body && inComments && inBody && noEmDash);
    } catch (e) { res.note = (res.note ? res.note + "; " : "") + "claude: " + String(e).slice(0, 100); }
  }

  if (ok) {
    const footer = String(s.footer || "").replaceAll("{niche}", c.niche || "your space").replaceAll("{name}", (String(c.name || "").split(" ")[0] || "there"));
    let body = String(out.body).trim();
    if (footer.trim()) body += NL + NL + footer.trim();
    body = body.split(EM).join("-").split(EN).join("-");
    await db.from("outreach_creators").update({
      email: res.email, subject_override: String(out.subject).trim(), email_override: body,
      personalization_status: "done", personalization_pain: String(out.pain || "").slice(0, 300),
      personalization_quote: String(out.quote || "").slice(0, 300), personalized_at: new Date().toISOString(),
    }).eq("id", c.id);
    res.status = "done"; res.pain = out.pain; res.quote = out.quote;
  } else {
    await db.from("outreach_creators").update({ email: res.email, personalization_status: "needs_review", personalized_at: new Date().toISOString() }).eq("id", c.id);
    res.status = "needs_review"; res.reason = "could not ground a verbatim follower quote";
  }
  return res;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!APIFY_TOKEN) return json({ error: "APIFY_TOKEN secret not set." }, 400);
  if (!ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY secret not set in Supabase." }, 400);

  let probe: any = {};
  try { probe = await req.clone().json(); } catch { /* ignore */ }
  if (probe.listModels) {
    const r = await fetch("https://api.anthropic.com/v1/models?limit=100", { headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" } });
    const j = await r.json();
    return json({ status: r.status, model_in_use: MODEL, models: (j.data || []).map((m: any) => m.id) });
  }
  if (probe.debugClaude) {
    const dbg = await claudeRaw('Return ONLY strict JSON: {"ok": true, "n": 7}');
    return json({ debug: dbg });
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
  const limit = Math.min(Math.max(Number(body.limit) || 4, 1), 8);

  const { data: s } = await db.from("outreach_settings").select("*").eq("id", 1).single();

  let q = db.from("outreach_creators").select("*").eq("archived", false);
  if (ids.length) q = q.in("id", ids);
  else q = q.is("personalization_status", null).eq("status", "New").limit(limit);
  const { data: creators } = await q;
  const list = (creators || []).slice(0, limit);
  if (!list.length) return json({ done: 0, flagged: 0, remaining: 0, message: "Nothing to personalize." });

  const results = await Promise.all(list.map((c: any) => personalizeOne(c, s).catch((e) => ({ handle: c.handle, status: "error", note: String(e).slice(0, 140) }))));

  const { count } = await db.from("outreach_creators").select("*", { count: "exact", head: true })
    .eq("archived", false).eq("status", "New").is("personalization_status", null);

  return json({
    done: results.filter((r) => r.status === "done").length,
    flagged: results.filter((r) => r.status === "needs_review").length,
    remaining: count || 0, results,
  });
});
