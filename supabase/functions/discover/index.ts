// discover: Fetch button backend. Sources real Instagram creators by niche + follower band via Apify.
// Account-search per niche (parallel) -> profile scrape -> filter to band -> dedupe -> insert as New potential.
// Deployed to Supabase (project aiyfpbyrvpgtuuenrfph). Reads APIFY_TOKEN from Supabase secrets.
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

const BANDS: Record<string, [number, number]> = { a: [25000, 50000], b: [50000, 75000], c: [75000, 100000] };

const TERMS: Record<string, string[]> = {
  "Personal Finance": ["personal finance", "money coach"],
  "HVAC & Home Services": ["hvac", "home services"],
  "Fitness & Training": ["fitness coach", "personal trainer"],
  "Beauty & Skincare": ["skincare coach", "esthetician"],
  "Nutrition & Diet": ["nutrition coach", "registered dietitian"],
};
const termsFor = (n: string) => TERMS[n] || [n];

async function apify(actor: string, input: unknown, timeoutS = 90) {
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=${timeoutS}`;
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const text = await r.text();
  if (!r.ok) throw new Error(`apify ${actor} ${r.status}: ${text.slice(0, 160)}`);
  try { return JSON.parse(text); } catch { return []; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!APIFY_TOKEN) return json({ error: "Set the APIFY_TOKEN secret in Supabase to enable fetching." }, 400);

  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const niches: string[] = Array.isArray(body.niches) ? body.niches.filter(Boolean) : [];
  const bands: string[] = Array.isArray(body.bands) && body.bands.length ? body.bands : ["a", "b", "c"];
  const maxInsert = Math.min(Math.max(Number(body.max) || 40, 1), 120);
  if (!niches.length) return json({ error: "Pick at least one Industry filter before fetching." }, 400);

  let lo = Infinity, hi = -Infinity;
  for (const b of bands) { const rng = BANDS[b]; if (rng) { lo = Math.min(lo, rng[0]); hi = Math.max(hi, rng[1]); } }
  if (!isFinite(lo)) { lo = 25000; hi = 100000; }

  const [{ data: existing }, { data: supp }, { data: arch }] = await Promise.all([
    db.from("outreach_creators").select("handle"),
    db.from("outreach_suppression").select("handle, email"),
    db.from("outreach_archive").select("handle"),
  ]);
  const seen = new Set<string>();
  for (const r of existing || []) seen.add(String(r.handle || "").toLowerCase());
  for (const r of supp || []) if (r.handle) seen.add(String(r.handle).toLowerCase());
  for (const r of arch || []) if (r.handle) seen.add(String(r.handle).toLowerCase());

  const out: any = { requested: niches, scanned: 0, candidates: 0, inserted: 0, byNiche: {}, errors: [] };

  const perNiche = await Promise.all(niches.map(async (niche) => {
    const rows: any[] = []; let scanned = 0, candidates = 0;
    try {
      const cand = new Set<string>();
      const searches = await Promise.all(termsFor(niche).map((term) =>
        apify("apify~instagram-search-scraper", { search: term, searchType: "user", searchLimit: 20 }).catch(() => [])));
      for (const users of searches) for (const u of (users as any[]) || []) {
        const un = String(u.username || "").toLowerCase();
        if (un && !seen.has(un)) cand.add(un);
      }
      scanned = cand.size;
      if (cand.size) {
        const profiles = await apify("apify~instagram-profile-scraper", { usernames: [...cand].slice(0, 50) });
        for (const pr of (profiles as any[]) || []) {
          const handle = String(pr.username || "").toLowerCase();
          const followers = Number(pr.followersCount ?? pr.followers ?? 0);
          if (!handle || seen.has(handle)) continue;
          candidates++;
          if (followers < lo || followers > hi || pr.private) continue;
          const bio = String(pr.biography || "").slice(0, 400);
          const link = pr.externalUrl || (Array.isArray(pr.externalUrls) && pr.externalUrls[0]?.url) || null;
          rows.push({ handle, name: pr.fullName || pr.username || handle, url: `https://instagram.com/${handle}`,
            followers_num: followers, niche, content_style: null, link, email: pr.businessEmail || pr.publicEmail || null,
            ig_dm_sent: false, audience_problem: "", evidence: bio, fit: null, compliment: "", problem: "",
            status: "New", first_email_approved: false, archived: false });
        }
      }
    } catch (e) { out.errors.push(`${niche}: ${String(e).slice(0, 160)}`); }
    return { niche, scanned, candidates, rows };
  }));

  const toInsert: any[] = [];
  for (const pn of perNiche) {
    out.scanned += pn.scanned; out.candidates += pn.candidates; out.byNiche[pn.niche] = 0;
    for (const row of pn.rows) {
      if (toInsert.length >= maxInsert || out.byNiche[pn.niche] >= 15) break;
      if (seen.has(row.handle)) continue;
      seen.add(row.handle); toInsert.push(row); out.byNiche[pn.niche]++;
    }
  }
  if (toInsert.length) {
    const { error } = await db.from("outreach_creators").upsert(toInsert, { onConflict: "handle", ignoreDuplicates: true });
    if (error) out.errors.push("insert: " + error.message); else out.inserted = toInsert.length;
  }
  return json(out);
});
