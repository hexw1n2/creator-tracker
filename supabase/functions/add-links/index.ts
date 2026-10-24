// Adds TikTok links and/or @handles for the signed-in owner.
// Body: { text: string, campaign_id?: string }. Short links (vm/vt.tiktok.com) are resolved here.
import { createClient } from 'npm:@supabase/supabase-js@2';

// Only the hosted app (and local testing) may call this from a browser.
const ORIGINS = ['https://hexw1n2.github.io', 'http://localhost:8765', 'http://127.0.0.1:5500', 'http://localhost:5500'];
let cors: Record<string, string> = {};
const corsFor = (req: Request) => ({
  'Access-Control-Allow-Origin': ORIGINS.includes(req.headers.get('origin') ?? '') ? req.headers.get('origin')! : ORIGINS[0],
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const MAX_TEXT = 20000, MAX_ITEMS = 50;
// Only ever fetch TikTok's own hosts, including every redirect hop.
const isTikTokHost = (u: URL) => u.protocol === 'https:' && (u.hostname === 'tiktok.com' || u.hostname.endsWith('.tiktok.com'));

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const LINK_RE = /tiktok\.com\/@([\w.\-]+)\/(video|photo)\/(\d+)/i;

function publishableKey(): string {
  try {
    return JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')!)['default'];
  } catch {
    return Deno.env.get('SUPABASE_ANON_KEY')!;
  }
}

async function resolveShortLink(url: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    if (!isTikTokHost(new URL(url))) throw new Error('Link redirected outside TikTok');
    const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA } });
    const loc = res.headers.get('location');
    await res.body?.cancel();
    if (!loc) break;
    url = new URL(loc, url).toString();
    if (LINK_RE.test(url)) break;
  }
  return url;
}

// TikTok IDs carry the post time (unix seconds) in their top 32 bits.
const postedAt = (id: string) => new Date(Number(BigInt(id) >> 32n) * 1000).toISOString();

async function parseLink(input: string) {
  let url = input.trim().replace(/^http:\/\//i, 'https://');
  if (!/^https:\/\//i.test(url)) url = 'https://' + url;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Not a TikTok video link: ' + input.slice(0, 80)); }
  if (!isTikTokHost(parsed)) throw new Error('Not a TikTok link: ' + input.slice(0, 80));
  let m = (parsed.hostname + parsed.pathname).match(LINK_RE);
  if (!m && (/^(vm|vt)\.tiktok\.com$/i.test(parsed.hostname) || parsed.pathname.startsWith('/t/'))) {
    const r = new URL(await resolveShortLink(parsed.toString()));
    if (isTikTokHost(r)) m = (r.hostname + r.pathname).match(LINK_RE);
  }
  if (!m || m[3].length > 21) throw new Error('Not a TikTok video link: ' + input.slice(0, 80));
  const handle = m[1].toLowerCase();
  return { handle, id: m[3], url: `https://www.tiktok.com/@${handle}/${m[2].toLowerCase()}/${m[3]}`, posted: postedAt(m[3]) };
}

Deno.serve(async (req) => {
  cors = corsFor(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, publishableKey(), {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false },
  });
  const { data: owner, error: ownerErr } = await supabase.rpc('is_owner');
  if (ownerErr || !owner) return json({ error: 'Not signed in' }, 401);

  const { text = '', campaign_id } = await req.json().catch(() => ({}));
  let campaign = campaign_id as string | undefined;
  if (!campaign) {
    const { data } = await supabase.from('settings').select('current_campaign_id').eq('id', 1).single();
    campaign = data?.current_campaign_id;
  }
  if (!campaign) return json({ error: 'Pick a campaign first.' }, 400);

  // Shared text often wraps the link in words ("Check out this video! https://vm.tiktok.com/...").
  if (String(text).length > MAX_TEXT) return json({ error: 'Too much text at once. Paste fewer links.' }, 413);
  let items = String(text).split(/[\s,]+/).filter(Boolean);
  const links = items.filter((x) => /tiktok\.com\//i.test(x));
  if (links.length) items = links.concat(items.filter((x) => x.startsWith('@')));
  if (items.length > MAX_ITEMS) return json({ error: `Up to ${MAX_ITEMS} links at a time, please.` }, 413);

  const results: { ok: boolean; msg: string }[] = [];
  for (const item of items) {
    try {
      if (!item.includes('/')) {
        const handle = item.replace(/^@/, '').toLowerCase();
        if (!/^[\w.\-]{1,40}$/.test(handle)) throw new Error('Not a handle or link: ' + item.slice(0, 80));
        const { data, error } = await supabase.from('creators').upsert({ handle }, { onConflict: 'handle', ignoreDuplicates: true }).select();
        if (error) throw error;
        results.push({ ok: true, msg: data?.length ? `Added creator @${handle}` : `@${handle} already exists` });
        continue;
      }
      const p = await parseLink(item);
      const { data: newCreator, error: cErr } = await supabase
        .from('creators').upsert({ handle: p.handle }, { onConflict: 'handle', ignoreDuplicates: true }).select();
      if (cErr) throw cErr;
      const { data: existing } = await supabase.from('videos').select('id').eq('id', p.id).maybeSingle();
      if (existing) {
        results.push({ ok: false, msg: `Already tracked: @${p.handle} …${p.id.slice(-6)}` });
        continue;
      }
      const { error: vErr } = await supabase.from('videos').insert({
        id: p.id, creator: p.handle, campaign_id: campaign, url: p.url, posted_at: p.posted,
      });
      if (vErr) throw vErr;
      const day = new Date(p.posted).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      results.push({ ok: true, msg: `Added @${p.handle}${newCreator?.length ? ' (new creator)' : ''}, posted ${day}` });
    } catch (e) {
      results.push({ ok: false, msg: (e as Error).message ?? String(e) });
    }
  }
  return json({ results });
});
