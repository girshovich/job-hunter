interface AshbyApiLike {
  organization?: { name?: string | null } | null;
}

interface AshbyAppData {
  organization?: {
    name?: string | null;
  } | null;
}

function cleanCompanyName(value: string | null | undefined): string | null {
  const cleaned = (value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  const name = cleaned.replace(/\s+Jobs$/i, '').trim();
  if (!name || /^jobs$/i.test(name)) return null;
  return name;
}

function decodedSlugFallback(slug: string): string | null {
  let decoded = slug;
  try {
    decoded = decodeURIComponent(slug);
  } catch { /* keep original */ }

  const cleaned = decoded
    .replace(/[-_]+/g, ' ')
    .replace(/\b(careers?|jobs?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return null;
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

function extractAppDataName(html: string): string | null {
  const marker = 'window.__appData = ';
  const start = html.indexOf(marker);
  if (start < 0) return null;

  const jsonStart = start + marker.length;
  const end = html.indexOf('};', jsonStart);
  if (end < 0) return null;

  try {
    const data = JSON.parse(html.slice(jsonStart, end + 1)) as AshbyAppData;
    return cleanCompanyName(data.organization?.name);
  } catch {
    return null;
  }
}

function extractMetaName(html: string): string | null {
  const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:title["']/i)?.[1];
  const title = html.match(/<title>([^<]*)<\/title>/i)?.[1];
  return cleanCompanyName(ogTitle) ?? cleanCompanyName(title);
}

export async function resolveAshbyCompanyName(
  slug: string,
  apiBody?: AshbyApiLike | null,
  storedName?: string | null,
): Promise<string> {
  const htmlUrl = `https://jobs.ashbyhq.com/${slug}`;

  try {
    const res = await fetch(htmlUrl, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const html = await res.text();
      const htmlName = extractAppDataName(html) ?? extractMetaName(html);
      if (htmlName) return htmlName;
    }
  } catch { /* fall through to cheaper/local fallbacks */ }

  return cleanCompanyName(apiBody?.organization?.name)
    ?? cleanCompanyName(storedName)
    ?? decodedSlugFallback(slug)
    ?? slug;
}
