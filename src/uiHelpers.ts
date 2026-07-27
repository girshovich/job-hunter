type JobListPage = 'jobs-match' | 'jobs-all' | 'run-logs' | 'run-diff';
type Breakpoint = 'desktop' | 'mobile';
type HtmlAttrs = Record<string, unknown>;
type JobRowColumn = { key: string; label: string; width: string; fixed: boolean };

const COUNTRY_TO_CODE: Record<string, string> = {
  'Afghanistan': 'AF', 'Albania': 'AL', 'Algeria': 'DZ', 'Andorra': 'AD',
  'Angola': 'AO', 'Argentina': 'AR', 'Armenia': 'AM', 'Australia': 'AU',
  'Austria': 'AT', 'Azerbaijan': 'AZ', 'Bahrain': 'BH', 'Bangladesh': 'BD',
  'Belarus': 'BY', 'Belgium': 'BE', 'Belize': 'BZ', 'Bolivia': 'BO',
  'Bosnia and Herzegovina': 'BA', 'Botswana': 'BW', 'Brazil': 'BR',
  'Brunei': 'BN', 'Bulgaria': 'BG', 'Cambodia': 'KH', 'Cameroon': 'CM',
  'Canada': 'CA', 'Chile': 'CL', 'China': 'CN', 'Colombia': 'CO',
  'Costa Rica': 'CR', 'Croatia': 'HR', 'Cuba': 'CU', 'Cyprus': 'CY',
  'Czech Republic': 'CZ', 'Czechia': 'CZ', 'Denmark': 'DK',
  'Dominican Republic': 'DO', 'Ecuador': 'EC', 'Egypt': 'EG',
  'El Salvador': 'SV', 'Estonia': 'EE', 'Ethiopia': 'ET', 'Finland': 'FI',
  'France': 'FR', 'Georgia': 'GE', 'Germany': 'DE', 'Ghana': 'GH',
  'Greece': 'GR', 'Guatemala': 'GT', 'Honduras': 'HN', 'Hong Kong': 'HK',
  'Hungary': 'HU', 'Iceland': 'IS', 'India': 'IN', 'Indonesia': 'ID',
  'Iran': 'IR', 'Iraq': 'IQ', 'Ireland': 'IE', 'Israel': 'IL',
  'Italy': 'IT', 'Ivory Coast': 'CI', 'Jamaica': 'JM', 'Japan': 'JP',
  'Jordan': 'JO', 'Kazakhstan': 'KZ', 'Kenya': 'KE', 'Kosovo': 'XK',
  'Kuwait': 'KW', 'Kyrgyzstan': 'KG', 'Latvia': 'LV', 'Lebanon': 'LB',
  'Libya': 'LY', 'Liechtenstein': 'LI', 'Lithuania': 'LT', 'Luxembourg': 'LU',
  'Malaysia': 'MY', 'Malta': 'MT', 'Mexico': 'MX', 'Moldova': 'MD',
  'Monaco': 'MC', 'Mongolia': 'MN', 'Morocco': 'MA', 'Mozambique': 'MZ',
  'Myanmar': 'MM', 'Namibia': 'NA', 'Nepal': 'NP', 'Netherlands': 'NL',
  'New Zealand': 'NZ', 'Nicaragua': 'NI', 'Nigeria': 'NG', 'North Korea': 'KP',
  'North Macedonia': 'MK', 'Norway': 'NO', 'Oman': 'OM', 'Pakistan': 'PK',
  'Panama': 'PA', 'Paraguay': 'PY', 'Peru': 'PE', 'Philippines': 'PH',
  'Poland': 'PL', 'Portugal': 'PT', 'Qatar': 'QA', 'Romania': 'RO',
  'Russia': 'RU', 'Rwanda': 'RW', 'Saudi Arabia': 'SA', 'Senegal': 'SN',
  'Serbia': 'RS', 'Singapore': 'SG', 'Slovakia': 'SK', 'Slovenia': 'SI',
  'Somalia': 'SO', 'South Africa': 'ZA', 'South Korea': 'KR', 'Spain': 'ES',
  'Sri Lanka': 'LK', 'Sudan': 'SD', 'Sweden': 'SE', 'Switzerland': 'CH',
  'Syria': 'SY', 'Taiwan': 'TW', 'Tanzania': 'TZ', 'Thailand': 'TH',
  'Tunisia': 'TN', 'Turkey': 'TR', 'Uganda': 'UG', 'Ukraine': 'UA',
  'United Arab Emirates': 'AE', 'United Kingdom': 'GB', 'United States': 'US',
  'Uruguay': 'UY', 'Uzbekistan': 'UZ', 'Venezuela': 'VE', 'Vietnam': 'VN',
  'Yemen': 'YE', 'Zambia': 'ZM', 'Zimbabwe': 'ZW',
};

const VERDICT_LABELS: Record<string, string> = {
  STRONG_MATCH: 'Strong',
  WEAK_MATCH: 'Weak',
  NO_MATCH: 'No match',
  DUPLICATE: 'Duplicate',
  FILTERED: 'Filtered',
  BLACKLISTED: 'Blacklisted',
};

// DS v2 §5.2/§5.3 exact chip palettes (inline styles so colors match the mockup precisely).
const VERDICT_CHIP_STYLES: Record<string, string> = {
  STRONG_MATCH: 'background:var(--green-soft);color:var(--green2)',
  WEAK_MATCH: 'background:#fffaeb;color:#b54708',
  NO_MATCH: 'background:#fef3f2;color:#b42318',
  DUPLICATE: 'background:#f4f3ff;color:#6941c6',
};
const VERDICT_CHIP_FALLBACK = 'background:#f2f4f7;color:#5b6472';
const APPLIED_CHIP_STYLES: Record<number, string> = {
  0: 'background:#1f2634;color:#fff', // New — dark chip (DS §5.3)
  1: 'background:var(--green);color:#fff', // Applied — DS --green (§5.3)
  2: 'background:var(--red);color:#fff', // Won't apply — DS --red (§5.3)
};

export function getVerdictChipStyle(value: unknown): string {
  const key = String(value ?? '').trim().toUpperCase();
  return VERDICT_CHIP_STYLES[key] ?? VERDICT_CHIP_FALLBACK;
}
export function getAppliedChipStyle(value: unknown): string {
  const n = Number(value);
  return APPLIED_CHIP_STYLES[n === 1 ? 1 : n === 2 ? 2 : 0];
}

const VERDICT_TONES: Record<string, string> = {
  STRONG_MATCH: 'bg-emerald-50 text-emerald-700',
  WEAK_MATCH: 'bg-yellow-50 text-yellow-700',
  NO_MATCH: 'bg-red-50 text-red-600',
  DUPLICATE: 'bg-purple-50 text-purple-600',
  FILTERED: 'bg-slate-100 text-slate-500',
  BLACKLISTED: 'bg-gray-100 text-gray-600',
};

const SOURCE_LABELS: Record<string, string> = {
  harvestapi: 'LinkedIn: harvestapi',
  valig: 'LinkedIn: valig (L)',
  indeed: 'Indeed: valig (I)',
  stepstone: 'StepStone: valig (S)',
  greenhouse: 'Greenhouse (ATS)',
  ashby: 'Ashby (ATS)',
  lever: 'Lever (ATS)',
  telegram: 'Telegram',
  LinkedIn: 'LinkedIn',
  Indeed: 'Indeed',
  StepStone: 'StepStone',
  Greenhouse: 'Greenhouse',
  Ashby: 'Ashby',
  Lever: 'Lever',
  Telegram: 'Telegram',
};

const SOURCE_NAMES: Record<string, string> = {
  harvestapi: 'LinkedIn',
  valig: 'LinkedIn',
  linkedin: 'LinkedIn',
  LinkedIn: 'LinkedIn',
  indeed: 'Indeed',
  Indeed: 'Indeed',
  stepstone: 'StepStone',
  StepStone: 'StepStone',
  greenhouse: 'Greenhouse',
  Greenhouse: 'Greenhouse',
  ashby: 'Ashby',
  Ashby: 'Ashby',
  lever: 'Lever',
  Lever: 'Lever',
  telegram: 'Telegram',
  Telegram: 'Telegram',
};

function humanizeToken(value: unknown, fallback: string): string {
  if (value == null || value === '') return fallback;
  return String(value)
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function attrsToHtml(attrs: HtmlAttrs = {}): string {
  return Object.entries(attrs)
    .filter(([, value]) => value !== false && value !== null && value !== undefined)
    .map(([key, value]) => value === true ? escapeHtml(key) : `${escapeHtml(key)}="${escapeHtml(value)}"`)
    .join(' ');
}

export function formatVerdictLabel(value: unknown): string {
  if (value == null || value === '') return 'Unknown';
  const key = String(value).trim().toUpperCase();
  return VERDICT_LABELS[key] ?? humanizeToken(key, 'Unknown');
}

export function getVerdictTone(value: unknown): string {
  const key = String(value ?? '').trim().toUpperCase();
  return VERDICT_TONES[key] ?? 'bg-gray-100 text-gray-500';
}

export function isVerdictEditable(value: unknown): boolean {
  const key = String(value ?? '').trim().toUpperCase();
  return ['STRONG_MATCH', 'WEAK_MATCH', 'NO_MATCH', 'DUPLICATE'].includes(key);
}

export function formatScore(value: unknown): string {
  if (value == null || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return String(Math.round(num));
}

export function formatAppliedLabel(value: unknown): string {
  const n = Number(value);
  return n === 1 ? 'Applied' : n === 2 ? "Won't Apply" : 'New';
}

export function formatRunStatusLabel(value: unknown): string {
  const key = String(value ?? '').trim().toLowerCase();
  return key === 'partial_error' ? 'partial error' : key;
}

export function formatDateTimeToMinutes(value: unknown, timezone = 'UTC'): string {
  if (value == null || value === '') return '—';
  const raw = String(value);
  // SQLite datetime('now') yields naive UTC "YYYY-MM-DD HH:MM:SS" (no zone); mark it UTC
  // so it converts to the target timezone instead of being parsed as local time.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16) || '—';
  const datePart = date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: timezone,
  });
  const timePart = date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  });
  return `${datePart} ${timePart}`;
}

export function formatSourceLabel(value: unknown): string {
  if (value == null || value === '') return 'Unknown source';
  const key = String(value).trim();
  return SOURCE_LABELS[key] ?? humanizeToken(key, 'Unknown source');
}

export function formatSourceName(value: unknown): string {
  if (value == null || value === '') return 'Source';
  const key = String(value).trim();
  return SOURCE_NAMES[key] ?? humanizeToken(key, 'Source');
}

export function renderPageHeader(title: unknown, subtitle?: unknown, actionsHtml = ''): string {
  const subtitleHtml = subtitle
    ? `<p style="font-size:13px;color:var(--muted);margin-top:3px">${escapeHtml(subtitle)}</p>`
    : '';
  const actions = actionsHtml
    ? `<div class="flex items-center gap-2 flex-shrink-0">${actionsHtml}</div>`
    : '';
  return `<div class="flex items-end justify-between gap-4" style="margin-bottom:22px"><div><h1 style="font-size:21px;font-weight:800;letter-spacing:-.02em;color:var(--ink)">${escapeHtml(title)}</h1>${subtitleHtml}</div>${actions}</div>`;
}

export function renderEmptyState(message: unknown, iconPath?: string): string {
  const icon = iconPath
    ? `<svg class="w-10 h-10 text-gray-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="${iconPath}"/></svg>`
    : '';
  return `<div class="jh-card p-12 text-center">${icon}<p class="text-sm text-gray-500">${escapeHtml(message)}</p></div>`;
}

export function renderDottedPopupLink(label: unknown, attrs: HtmlAttrs = {}): string {
  const className = `text-sm font-semibold text-gray-700 underline decoration-dotted underline-offset-4 hover:text-blue-700 ${attrs.class ?? ''}`.trim();
  const htmlAttrs = attrsToHtml({ type: 'button', ...attrs, class: className });
  return `<button ${htmlAttrs}>${escapeHtml(label)}</button>`;
}

export function renderVerdictChip(value: unknown, options: { editable?: boolean; rounded?: boolean } = {}): string {
  const editable = options.editable ?? false;
  const label = `${formatVerdictLabel(value)}${editable && isVerdictEditable(value) ? ' ▾' : ''}`;
  return `<span style="display:inline-flex;align-items:center;gap:3px;height:22px;padding:0 8px;border-radius:7px;font-size:11.5px;font-weight:700;white-space:nowrap;${getVerdictChipStyle(value)}">${escapeHtml(label)}</span>`;
}

export function renderVerdictSelector(value: unknown, attrs: HtmlAttrs = {}): string {
  if (!isVerdictEditable(value)) return renderVerdictChip(value);
  const className = `verdict-btn ${attrs.class ?? ''}`.trim();
  const htmlAttrs = attrsToHtml({ ...attrs, class: className });
  return `<button ${htmlAttrs}>${renderVerdictChip(value, { editable: true, rounded: attrs['data-chip-style'] === 'detail' })}</button>`;
}

export function renderAppliedChip(value: unknown, options: { editable?: boolean; full?: boolean } = {}): string {
  const caret = options.editable ? ' ▾' : '';
  const width = options.full ? 'width:100%;justify-content:center;' : '';
  return `<span style="display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 10px;border-radius:8px;font-size:11.5px;font-weight:700;white-space:nowrap;${width}${getAppliedChipStyle(value)}">${formatAppliedLabel(value)}${caret}</span>`;
}

export function renderAppliedSelector(value: unknown, attrs: HtmlAttrs = {}): string {
  const full = attrs['data-chip-style'] === 'detail';
  const state = Number(value) === 1 ? 1 : Number(value) === 2 ? 2 : 0;
  const className = `applied-btn ${full ? 'w-full ' : ''}cursor-pointer ${attrs.class ?? ''}`.trim();
  const htmlAttrs = attrsToHtml({ type: 'button', 'data-applied': String(state), ...attrs, class: className });
  return `<button ${htmlAttrs}>${renderAppliedChip(value, { editable: true, full })}</button>`;
}

export function renderScoreCell(value: unknown, verdict?: unknown): string {
  // DS §5.1: the score badge takes the verdict tone when a verdict is known (list cards,
  // Run Diff, Run Logs). Callers without a verdict (e.g. Start's Last Session) fall back to
  // the score-threshold tone so their look is unchanged until their own phase reskins them.
  const num = Number(value);
  const tone = verdict != null && verdict !== ''
    ? getVerdictChipStyle(verdict)
    : (Number.isFinite(num) && num >= 71 ? 'background:var(--green-soft);color:#178049' : 'background:#f2f4f7;color:#5b6472');
  return `<span style="display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:23px;padding:0 8px;border-radius:7px;font-size:12px;font-weight:800;font-variant-numeric:tabular-nums;${tone}">${formatScore(value)}</span>`;
}

export function renderDateTimeCell(value: unknown, timezone = 'UTC'): string {
  return `<span class="text-xs text-gray-500 whitespace-nowrap">${escapeHtml(formatDateTimeToMinutes(value, timezone))}</span>`;
}

export function renderSourceLinkCell(url: unknown, source: unknown = 'Source', tooltip?: string): string {
  if (url == null || url === '') return '<span class="text-xs text-gray-300">—</span>';
  const title = tooltip ?? `Open ${formatSourceLabel(source)}`;
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}" class="source-link-cell inline-flex h-7 w-7 items-center justify-center rounded-lg text-blue-600 hover:bg-blue-50 hover:text-blue-800 transition-colors"><svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 17L17 7M9 7h8v8"/></svg></a>`;
}

export function renderJobListContainer(innerHtml: string): string {
  return `<div class="job-list-container">${innerHtml}</div>`;
}

export function getJobTableClass(): string {
  return 'job-table job-desktop-table';
}

export function getJobTableRowClass(extra = ''): string {
  return `job-table-row ${extra}`.trim();
}

export function getJobTableCellClass(kind = ''): string {
  const fixed = ['score', 'verdict', 'applied', 'date', 'source'].includes(kind) ? ' job-table-fixed' : '';
  return `job-table-cell${fixed}`.trim();
}

export function getJobMobileListClass(): string {
  return 'job-mobile-list space-y-2';
}

export function getJobMobileCardClass(extra = ''): string {
  return `job-mobile-card ${extra}`.trim();
}

export function renderJobIdentityBlock(title: unknown, company: unknown, href?: unknown, logoUrl?: string | null): string {
  const titleText = escapeHtml(title || 'Untitled role');
  const titleHtml = href
    ? `<a href="${escapeHtml(href)}" class="job-identity-title text-sm font-semibold text-gray-900 hover:text-blue-600 transition-colors">${titleText}</a>`
    : `<span class="job-identity-title text-sm font-semibold text-gray-900">${titleText}</span>`;
  const logo = renderCompanyLogo(String(company || ''), logoUrl);
  return `<div class="flex items-start gap-2 min-w-0">${logo}<div class="min-w-0 flex-1">${titleHtml}<span class="job-identity-meta text-xs text-gray-500 mt-0.5">${escapeHtml(company || 'Unknown company')}</span></div></div>`;
}

export function renderJobPositionCompanyCell(title: unknown, company: unknown, href?: unknown, logoUrl?: string | null): string {
  return renderJobIdentityBlock(title, company, href, logoUrl);
}

export function renderJobSummaryCell(summary: unknown): string {
  return summary
    ? `<span class="job-summary-text text-xs leading-relaxed text-gray-600">${escapeHtml(summary)}</span>`
    : '<span class="text-xs text-gray-300 italic">—</span>';
}

export function countryToFlag(country: string | null | undefined): string {
  if (!country) return '';
  const code = COUNTRY_TO_CODE[country];
  if (!code) return '';
  return [...code].map((c) => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join('');
}

export function renderCompanyLogo(company: string, logoUrl?: string | null): string {
  const letter = escapeHtml((company || 'U').charAt(0).toUpperCase());
  if (!logoUrl) {
    return `<span class="inline-flex flex-shrink-0 w-6 h-6 rounded items-center justify-center bg-slate-100 text-slate-500 text-xs font-bold select-none">${letter}</span>`;
  }
  return `<span class="relative inline-flex flex-shrink-0 w-6 h-6 rounded">` +
    `<span class="absolute inset-0 flex items-center justify-center bg-slate-100 text-slate-500 text-xs font-bold select-none rounded">${letter}</span>` +
    `<img src="${escapeHtml(logoUrl)}" class="absolute inset-0 w-6 h-6 object-contain rounded bg-white" alt="" loading="lazy" onerror="this.style.display='none'">` +
    `</span>`;
}

export type LocationPreference = { preferred?: Set<string>; currentLocation?: string };

/**
 * Picks a multi-country job's displayed primary label + flag country, per viewing profile.
 * 1) current_location when it's preferred AND one of the job's labels; 2) first label (in
 * label order) whose country is preferred; 3) fallback: first label + the stored primary
 * country. The flag follows the chosen label, not jobs.country. No pref → rung 3 (legacy).
 */
export function pickPrimaryLocation(
  locationLabels: string[] | undefined,
  country?: string | null,
  pref?: LocationPreference,
): { primary: string | null; flagCountry: string | null } {
  const labels = locationLabels ?? [];
  const preferred = pref?.preferred;
  if (preferred && preferred.size && labels.length) {
    const cur = pref?.currentLocation;
    if (cur && preferred.has(cur)) {
      const home = labels.find((l) => l.toLowerCase().trim() === cur);
      if (home) return { primary: home, flagCountry: home };
    }
    const hit = labels.find((l) => preferred.has(l.toLowerCase().trim()));
    if (hit) return { primary: hit, flagCountry: hit };
  }
  return { primary: labels[0] ?? null, flagCountry: country ?? null };
}

export function renderLocationCell(location: unknown, country?: string | null, locationLabels?: string[], pref?: LocationPreference): string {
  const picked = pickPrimaryLocation(locationLabels, country, pref);
  const primary = picked.primary ?? location;
  if (!primary) return '<span class="text-xs text-gray-300">—</span>';
  const extra = locationLabels && locationLabels.length > 1 ? locationLabels.length - 1 : 0;
  const badge = extra > 0 ? ` <span class="text-gray-400">+${extra}</span>` : '';
  const flag = countryToFlag(picked.flagCountry);
  const text = `<span class="job-location-text text-xs leading-snug text-gray-500">${escapeHtml(primary)}${badge}</span>`;
  return flag ? `<span class="inline-flex items-start gap-1">${flag} ${text}</span>` : text;
}

export function renderJobTableHeader(page: JobListPage): string {
  const columns = getJobRowColumns(page, 'desktop');
  const cells = columns
    .map((col) => {
      const label = col.key === 'source'
        ? '<span class="sr-only">Source</span>'
        : escapeHtml(col.label);
      return `<th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide ${col.fixed ? 'text-center' : ''}">${label}</th>`;
    })
    .join('');
  return `<thead class="bg-gray-50"><tr>${cells}</tr></thead>`;
}

export function renderJobsAllColgroup(): string {
  const columns = getJobRowColumns('jobs-all', 'desktop');
  return `<colgroup>${columns.map((col) => `<col style="width:${escapeHtml(col.width)};">`).join('')}</colgroup>`;
}

export function renderJobsAllTableHeader(): string {
  return renderJobTableHeader('jobs-all');
}

// DS v2 tally colors (§5.2 verdict palette), used by the run-status count pills.
const RUN_TALLY_COLORS: Record<string, string> = {
  strong: '#178049',
  weak: '#b54708',
  no_match: '#b42318',
  duplicate: '#6941c6',
  filtered: '#8a91a0',
  blacklisted: '#b42318',
};

export function renderRunStatusCounts(run: Record<string, unknown>): string {
  return getRunStatusCounts(run)
    .filter((count) => count.value > 0 || ['strong', 'weak', 'no_match', 'duplicate', 'filtered'].includes(count.key))
    .map((count) => `<span style="display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:700;color:${RUN_TALLY_COLORS[count.key]};white-space:nowrap"><span style="width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.85"></span>${escapeHtml(count.value)} ${escapeHtml(count.label.toLowerCase())}</span>`)
    .join('');
}

export function getJobRowColumns(page: JobListPage, breakpoint: Breakpoint = 'desktop'): JobRowColumn[] {
  const fixed = {
    score: { key: 'score', label: 'Score', width: '56px', fixed: true },
    verdict: { key: 'verdict', label: 'Verdict', width: '88px', fixed: true },
    applied: { key: 'applied', label: 'Applied', width: '150px', fixed: true },
    date: { key: 'date', label: 'Date', width: '150px', fixed: true },
    source: { key: 'source', label: 'Source', width: '44px', fixed: true },
  };
  if (page === 'jobs-match') {
    return [
      { key: 'position', label: 'Position', width: '250px', fixed: false },
      { key: 'summary', label: 'Summary', width: 'auto', fixed: false },
      { key: 'location', label: 'Location', width: '150px', fixed: false },
      fixed.score,
      fixed.verdict,
      fixed.applied,
      fixed.source,
    ];
  }
  return [
    { key: 'position', label: 'Position', width: 'auto', fixed: false },
    { key: 'location', label: 'Location', width: '150px', fixed: false },
    fixed.score,
    fixed.verdict,
    fixed.date,
    fixed.source,
  ];
}

export function getMobileJobCardLayout(page: JobListPage) {
  const common = ['position-score', 'company-verdict', 'location'];
  if (page === 'jobs-match') return [...common, 'summary', 'applied-source'];
  if (page === 'run-diff') return [...common, 'comparison-source'];
  return [...common, 'date-source'];
}

export function getRunStatusCounts(run: Record<string, unknown>) {
  return [
    { key: 'strong', label: 'Strong', value: Number(run.jobs_strong_match ?? 0) },
    { key: 'weak', label: 'Weak', value: Number(run.jobs_weak_match ?? 0) },
    { key: 'no_match', label: 'No match', value: Number(run.jobs_no_match ?? 0) },
    { key: 'duplicate', label: 'Duplicate', value: Number(run.jobs_duplicate ?? 0) },
    { key: 'filtered', label: 'Filtered', value: Number(run.filtered_count ?? 0) },
    { key: 'blacklisted', label: 'Blacklisted', value: Number(run.blacklisted_count ?? 0) },
  ];
}

export function formatRunCost(value: unknown): string {
  if (value == null || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `$${num.toFixed(4)}`;
}

export function truncateTextClass(kind: unknown): string {
  const key = String(kind ?? '').trim().toLowerCase();
  if (key === 'summary') return 'min-w-0 overflow-hidden text-ellipsis line-clamp-3';
  if (key === 'location') return 'min-w-0 overflow-hidden text-ellipsis line-clamp-2';
  return 'min-w-0 truncate';
}

export function getResponsiveListMode(width: unknown): 'desktop' | 'mobile' {
  const num = Number(width);
  return Number.isFinite(num) && num >= 768 ? 'desktop' : 'mobile';
}

export function getClientUiTokens() {
  return {
    verdictLabels: VERDICT_LABELS,
    verdictTones: VERDICT_TONES,
    editableVerdicts: ['STRONG_MATCH', 'WEAK_MATCH', 'NO_MATCH', 'DUPLICATE'],
    verdictChipStyles: VERDICT_CHIP_STYLES,
    verdictChipFallback: VERDICT_CHIP_FALLBACK,
    appliedChipStyles: APPLIED_CHIP_STYLES,
  };
}

export const uiHelpers = {
  escapeHtml,
  formatVerdictLabel,
  getVerdictTone,
  isVerdictEditable,
  formatScore,
  formatAppliedLabel,
  formatRunStatusLabel,
  formatDateTimeToMinutes,
  formatSourceLabel,
  formatSourceName,
  renderPageHeader,
  renderEmptyState,
  renderDottedPopupLink,
  renderVerdictChip,
  renderVerdictSelector,
  renderAppliedSelector,
  getVerdictChipStyle,
  renderScoreCell,
  renderDateTimeCell,
  renderSourceLinkCell,
  renderJobListContainer,
  getJobTableClass,
  getJobTableRowClass,
  getJobTableCellClass,
  getJobMobileListClass,
  getJobMobileCardClass,
  renderJobIdentityBlock,
  renderJobPositionCompanyCell,
  renderJobSummaryCell,
  renderLocationCell,
  pickPrimaryLocation,
  renderJobTableHeader,
  renderJobsAllColgroup,
  renderJobsAllTableHeader,
  renderRunStatusCounts,
  getJobRowColumns,
  getMobileJobCardLayout,
  getRunStatusCounts,
  formatRunCost,
  truncateTextClass,
  getResponsiveListMode,
  getClientUiTokens,
  countryToFlag,
  renderCompanyLogo,
};
