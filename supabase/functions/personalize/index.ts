// personalize: writes a per-creator outreach email grounded in the creator's real circumstance
// and a verbatim quote from a real follower comment (audience pain point / demand).
// Flow: profile scrape (email + captions + post urls) -> comment scrape (audience voice)
// -> Claude writes {subject, body, quote, pain} -> verify quote is real + present -> retry -> flag if failing.
// Deployed to Supabase (project aiyfpbyrvpgtuuenrfph). Reads APIFY_TOKEN + ANTHROPIC_API_KEY secrets.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APIFY_TOKEN = Deno.env.get("APIFY_TOKEN") || "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-3-5-sonnet-latest";

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

async function claude(prompt: string): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 900, messages: [{ role: "user", content: prompt }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return (j.content && j.content[0] && j.content[0].text) || "";
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
    "You write ONE cold outreach email for a real Instagram creator. It must sound like a human wrote it, not AI.",
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
    "OFFER (from " + fromName + "): " + fromName + " is building " + product + ". He is recruiting a few creators as founding affiliates at a 50 percent revenue share. The creator just shares it with their audience; " + fromName + " builds the product and handles delivery and support. The creator builds nothing.",
    "",
    "WRITE THE EMAIL SO THAT:",
    "1. It is specific to THIS creator, drawn from their bio and captions (name what they actually do).",
    "2. It quotes ONE real follower comment VERBATIM (copy it exactly from the list) and connects that audience pain point or demand to why the 50 percent affiliate product fits them.",
    "3. Human voice, warm, direct, concise (max about 130 words). NO em dashes. No AI cliches. Do not invent facts, numbers, or names.",
    "4. End with a soft question and sign off as " + fromName + ".",
    sternLine,
    "",
    "Return ONLY strict JSON, no prose:",
    '{"subject":"<short subject, use their first name or handle naturally>","body":"<email body, with the verbatim quote inside it>","quote":"<the exact follower comment you quoted>","pain":"<one line: the audience pain point or demand you addressed>"}',
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
    const body = String(out.body).trim() + NL + NL + (s.footer || "") + NL + (s.address || "");
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
