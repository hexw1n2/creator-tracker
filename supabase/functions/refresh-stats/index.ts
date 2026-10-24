// Refreshes views/likes/comments/shares for recent videos and logs a daily snapshot.
// Called by the app (owner's login) or by the daily cron job (x-cron-token header).
// Uses Apify when an APIFY_TOKEN secret is set; otherwise tries TikTok's public page (often blocked).
import { createClient } from 'npm:@supabase/supabase-js@2';

// Only the hosted app (and local testing) may call this from a browser. The cron job doesn't send an Origin.
const ORIGINS = ['https://hexw1n2.github.io', 'http://localhost:8765', 'http://127.0.0.1:5500', 'http://localhost:5500'];
let cors: Record<string, string> = {};
const corsFor = (req: Request) => ({
  'Access-Control-Allow-Origin': ORIGINS.includes(req.headers.get('origin') ?? '') ? req.headers.get('origin')! : ORIGINS[0],
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
});

// Compares secrets without leaking how many characters matched.
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
const isTikTokUrl = (s: string) => {
  try { const u = new URL(s); return u.protocol === 'https:' && (u.hostname === 'tiktok.com' || u.hostname.endsWith('.tiktok.com')); }
  catch { return false; }
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
type Stats = { views: number; likes: number; comments: number; shares: number };

function key(env: string, legacy: string): string {
  const v = Deno.env.get(legacy);
  if (v) return v;
  return JSON.parse(Deno.env.get(env)!)['default'];
}

async function fetchDirect(url: string): Promise<Stats | null> {
  if (!isTikTokUrl(url)) return null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
    const html = await res.text();
    const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    const item = JSON.parse(m[1]).__DEFAULT_SCOPE__['webapp.video-detail'].itemInfo.itemStruct;
    const st = item.statsV2 || item.stats;
    return { views: +st.playCount || 0, likes: +st.diggCount || 0, comments: +st.commentCount || 0, shares: +st.shareCount || 0 };
  } catch {
    return null;
  }
}

async function fetchApify(urls: string[], token: string): Promise<Record<string, Stats>> {
  const out: Record<string, Stats> = {};
  for (let i = 0; i < urls.length; i += 50) {
    const res = await fetch(
      'https://api.apify.com/v2/acts/clockworks~tiktok-scraper/run-sync-get-dataset-items',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ postURLs: urls.slice(i, i + 50), resultsPerPage: 1, shouldDownloadVideos: false, shouldDownloadCovers: false }),
      },
    );
    if (!res.ok) {
      console.warn('Apify error', res.status, (await res.text()).slice(0, 300));
      continue;
    }
    for (const item of await res.json()) {
      if (item?.id) out[String(item.id)] = { views: item.playCount || 0, likes: item.diggCount || 0, comments: item.commentCount || 0, shares: item.shareCount || 0 };
    }
  }
  return out;
}

Deno.serve(async (req) => {
  cors = corsFor(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, key('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  // Authorize: cron token, or the signed-in owner.
  const cronToken = req.headers.get('x-cron-token');
  let allowed = false;
  if (cronToken) {
    const { data } = await admin.from('app_secrets').select('value').eq('name', 'cron_token').single();
    allowed = !!data && sameSecret(data.value, cronToken);
  } else {
    const user = createClient(url, key('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY'), {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
      auth: { persistSession: false },
    });
    const { data } = await user.rpc('is_owner');
    allowed = data === true;
  }
  if (!allowed) return json({ error: 'Not allowed' }, 401);

  const { data: settings } = await admin.from('settings').select('track_stats_days').eq('id', 1).single();
  const days = settings?.track_stats_days ?? 30;
  let q = admin.from('videos').select('id, url').neq('status', 'Rejected').limit(2000);
  if (days > 0) q = q.gte('posted_at', new Date(Date.now() - days * 86400000).toISOString());
  const { data: videos, error } = await q;
  if (error) return json({ error: error.message }, 500);
  if (!videos?.length) return json({ updated: 0, failed: 0 });

  const apify = Deno.env.get('APIFY_TOKEN');
  let stats: Record<string, Stats> = {};
  if (apify) {
    stats = await fetchApify(videos.map((v) => v.url).filter(isTikTokUrl), apify);
  } else {
    for (let i = 0; i < videos.length; i += 5) {
      const batch = videos.slice(i, i + 5);
      const got = await Promise.all(batch.map((v) => fetchDirect(v.url)));
      batch.forEach((v, j) => { if (got[j]) stats[v.id] = got[j]!; });
    }
  }

  const now = new Date().toISOString();
  const snapshots = [];
  for (const v of videos) {
    const st = stats[v.id];
    if (!st) continue;
    await admin.from('videos').update({ ...st, stats_updated_at: now }).eq('id', v.id);
    snapshots.push({ video_id: v.id, captured_at: now, ...st });
  }
  if (snapshots.length) await admin.from('video_stats').insert(snapshots);
  await admin.from('settings').update({ last_stats_run: now }).eq('id', 1);
  return json({ updated: snapshots.length, failed: videos.length - snapshots.length, source: apify ? 'apify' : 'direct' });
});
