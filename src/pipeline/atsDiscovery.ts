import type { Database } from '../db';

const ATS_DOMAINS: Record<string, string> = {
  'boards.greenhouse.io': 'greenhouse',
  'jobs.lever.co':        'lever',
  'jobs.ashbyhq.com':     'ashby',
};

const GENERIC_SEGMENTS = new Set([
  'api', 'embed', 'static', 'assets', 'images', 'js', 'css',
  'favicon.ico', 'robots.txt',
]);

interface CdxRecord {
  url: string;
}

interface CollInfo {
  id: string;
  from: string;
}

function extractSlug(url: string, atsDomain: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== atsDomain) return null;
    const seg = u.pathname.split('/').filter(Boolean)[0];
    if (!seg) return null;
    if (seg.includes('.')) return null;
    if (seg.startsWith('_') || seg.startsWith('v')) return null;
    if (GENERIC_SEGMENTS.has(seg)) return null;
    return seg.toLowerCase();
  } catch {
    return null;
  }
}

async function fetchSnapshots(): Promise<CollInfo[]> {
  const res = await fetch('https://index.commoncrawl.org/collinfo.json');
  if (!res.ok) throw new Error(`collinfo.json fetch failed: ${res.status}`);
  const all = await res.json() as CollInfo[];
  return all
    .filter((c) => c.from)
    .sort((a, b) => b.from.localeCompare(a.from))
    .slice(0, 3);
}

async function fetchCdxPage(snapshotId: string, domain: string, offset: number): Promise<CdxRecord[]> {
  const url = `https://index.commoncrawl.org/${snapshotId}-index?url=${encodeURIComponent(domain + '/*')}&output=json&fl=url&limit=50000&offset=${offset}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  } catch {
    return [];
  }
  if (res.status === 404 || res.status === 400) return [];
  if (!res.ok) throw new Error(`CDX error ${res.status} for ${domain} offset ${offset}`);
  const text = await res.text();
  if (!text.trim()) return [];
  return text.trim().split('\n').map((line) => {
    try { return JSON.parse(line) as CdxRecord; } catch { return null; }
  }).filter(Boolean) as CdxRecord[];
}

export async function runDiscovery(db: Database): Promise<{ inserted: number; skipped: number }> {
  console.log('[ats-discovery] Starting discovery run');
  const snapshots = await fetchSnapshots();
  console.log(`[ats-discovery] Using snapshots: ${snapshots.map((s) => s.id).join(', ')}`);

  const upsert = db.prepare<{ lastInsertRowid: number; changes: number }>(`
    INSERT INTO ats_boards (ats, slug, is_active, discovered_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT (ats, slug) DO NOTHING
  `);

  let inserted = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  for (const snapshot of snapshots) {
    for (const [domain, ats] of Object.entries(ATS_DOMAINS)) {
      let offset = 0;
      let page = 0;
      while (true) {
        page++;
        console.log(`[ats-discovery] ${snapshot.id} / ${domain} page ${page} (offset ${offset})`);
        const records = await fetchCdxPage(snapshot.id, domain, offset);
        if (records.length === 0) break;

        let pageInserted = 0;
        for (const record of records) {
          const slug = extractSlug(record.url, domain);
          if (!slug) continue;
          const result = upsert.run(ats, slug, now);
          if (result.changes > 0) { inserted++; pageInserted++; }
          else skipped++;
        }
        console.log(`[ats-discovery]   → ${records.length} URLs, ${pageInserted} new slugs`);

        if (records.length < 50000) break;
        offset += records.length;
      }
    }
  }

  console.log(`[ats-discovery] Done. inserted=${inserted} skipped=${skipped}`);
  return { inserted, skipped };
}
