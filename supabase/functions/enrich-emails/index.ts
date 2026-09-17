// enrich-emails: maximize truthful contact coverage. Never invents a contact.
// Sources per creator: existing -> Apify businessEmail/publicEmail -> email in bio
// -> deep-crawl the page behind their link (vdrmota/contact-info-scraper) for email + WhatsApp + phone.
// Deployed to Supabase (project aiyfpbyrvpgtuuenrfph). Reads APIFY_TOKEN secret.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APIFY_TOKEN = Deno.env.get("APIFY_TOKEN") || "";

const db = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JUNK = ["example.com", "sentry.io", "wixpress.com", "email.com", "domain.com", "yourdomain", "godaddy", "cloudflare", "schema.org", "w3.org", "wix.com", "squarespace.com", "shopify", "gstatic", "googleapis", "sentry"];
function goodEmails(text: string): string[] {
  const found = String(text || "").match(EMAIL_RE) || [];
  const out: string[] = [];
  for (const e0 of found) {
    const e = e0.toLowerCase();
    if (e.length > 60) continue;
    if (JUNK.some((j) => e.includes(j))) continue;
    if (["png","jpg","jpeg","gif","webp","svg","css","js"].some((x) => e.endsWith("." + x))) continue;
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

async function apify(actor: string, input: unknown, timeoutS = 60) {
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=${timeoutS}`;
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const t = await r.text();
  if (!r.ok) throw new Error(`apify ${actor} ${r.status}`);
  try { return JSON.parse(t); } catch { return []; }
}

async function fetchPage(url: string): Promise<string> {
  try {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(url, { redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0" } });
    clearTimeout(id);
    if (!r.ok) return "";
    return (await r.text()).slice(0, 400000);
  } catch { return ""; }
}

async function enrichOne(c: any) {
  const res: any = { handle: c.handle, email: c.email || null, whatsapp: null, phone: null, source: c.email ? "existing" : null };
  if (res.email && c.whatsapp) return res;
  try {
    const prof = await apify("apify~instagram-profile-scraper", { usernames: [c.handle] }, 55);
    const p = (prof as any[])[0] || {};
    const be = (p.businessEmail || p.publicEmail || "").trim();
    if (!res.email && be && goodEmails(be)[0]) { res.email = goodEmails(be)[0]; res.source = "business"; }
    if (!res.email) { const b = goodEmails(p.biography)[0] || goodEmails(c.evidence)[0]; if (b) { res.email = b; res.source = "bio"; } }
    if (!c.link && p.externalUrl) c = { ...c, link: p.externalUrl };
  } catch (_e) { /* ignore */ }
  if (!res.email && c.link) {
    try {
      const items = await apify("vdrmota~contact-info-scraper", { startUrls: [{ url: c.link }], maxDepth: 2, maxRequestsPerStartUrl: 6, sameDomain: false }, 85);
      const emails: string[] = [], wapps: string[] = [], phs: string[] = [];
      for (const it of (items as any[]) || []) {
        for (const e of (it.emails || [])) emails.push(String(e));
        for (const w of (it.whatsapps || [])) wapps.push(String(w));
        for (const p of (it.phones || [])) phs.push(String(p));
      }
      const pick = goodEmails(emails.join(" "))[0];
      if (pick) { res.email = pick; res.source = "site"; }
      if (wapps[0]) res.whatsapp = wapps[0];
      if (phs[0]) res.phone = phs[0];
    } catch (_e) { /* ignore */ }
    if (!res.email) { const html = await fetchPage(c.link); const pick = goodEmails(html)[0]; if (pick) { res.email = pick; res.source = "link"; } }
  }
  const upd: any = {};
  if (res.email && !c.email) upd.email = res.email;
  if (res.whatsapp && !c.whatsapp) upd.whatsapp = res.whatsapp;
  if (res.phone && !c.phone) upd.phone = res.phone;
  if (Object.keys(upd).length) await db.from("outreach_creators").update(upd).eq("id", c.id);
  return res;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!APIFY_TOKEN) return json({ error: "APIFY_TOKEN secret not set." }, 400);
  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
  const limit = Math.min(Math.max(Number(body.limit) || 6, 1), 8);
  let q = db.from("outreach_creators").select("*").eq("archived", false);
  if (ids.length) q = q.in("id", ids); else q = q.or("email.is.null,email.eq.").limit(limit);
  const { data: creators } = await q;
  const list = (creators || []).slice(0, limit);
  if (!list.length) return json({ found: 0, waFound: 0, checked: 0, remaining: 0, message: "No creators need enrichment." });
  const results = await Promise.all(list.map((c: any) => enrichOne(c).catch(() => ({ handle: c.handle, email: null }))));
  const found = results.filter((r) => r.email && r.source !== "existing").length;
  const waFound = results.filter((r) => r.whatsapp).length;
  const { count } = await db.from("outreach_creators").select("*", { count: "exact", head: true }).eq("archived", false).or("email.is.null,email.eq.");
  return json({ found, waFound, checked: list.length, remaining: count || 0, results });
});
