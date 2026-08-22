/**
 * Word-set keyword matching for the pool providers (greenhouse, ashby, lever, telegram).
 *
 * A plain `LIKE '%keyword%'` needs the keyword's words adjacent and in order, so
 * "Director Product" matches "Director Product Management" but misses "Director of
 * Product Management", "Product Director" and "Senior Director, Product Management".
 * These helpers require every word of a keyword to be present instead, which is the
 * same rule `matchesTitleFilter` (runner.ts) already applies to every provider's results.
 *
 * Two stages: `buildKeywordClause` is the SQL recall net (substring LIKE per word, so
 * "head" still matches "overhead"), `matchesKeywords` is the precision pass that drops
 * those partial-word hits. Run the precision pass before description hydration.
 *
 * Used only by the four pool providers — the API-backed providers pass keywords
 * straight to their actor and are unaffected.
 */

function words(text: string): string[] {
  return text.toLowerCase().split(/\W+/).filter(Boolean);
}

/**
 * SQL clause matching rows where all words of at least one keyword appear in at least
 * one of `columns`. Columns are raw SQL expressions already lowercased by the caller.
 * Returns an empty clause when no keyword holds a usable word — callers keep their
 * existing `|| '1=1'` fallback.
 */
export function buildKeywordClause(
  keywords: string[],
  columns: string[],
): { clause: string; params: string[] } {
  const params: string[] = [];
  const perKeyword: string[] = [];

  for (const keyword of keywords) {
    const kw = words(keyword);
    if (kw.length === 0) continue;

    const perColumn = columns.map((col) => {
      kw.forEach((w) => params.push(`%${w}%`));
      return `(${kw.map(() => `${col} LIKE ?`).join(' AND ')})`;
    });
    perKeyword.push(`(${perColumn.join(' OR ')})`);
  }

  return { clause: perKeyword.join(' OR '), params };
}

/**
 * True when all words of at least one keyword appear as whole words in at least one
 * field. Fields are checked independently, so a keyword is never satisfied by words
 * split across title and description. No usable keyword → everything matches, mirroring
 * the `1=1` fallback.
 */
export function matchesKeywords(
  fields: Array<string | null | undefined>,
  keywords: string[],
): boolean {
  const kws = keywords.map(words).filter((kw) => kw.length > 0);
  if (kws.length === 0) return true;

  const fieldWords = fields.map((f) => new Set(words(f || '')));
  return kws.some((kw) => fieldWords.some((set) => kw.every((w) => set.has(w))));
}
