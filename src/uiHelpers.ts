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
  telegram: 'Telegram',
  LinkedIn: 'LinkedIn',
  Indeed: 'Indeed',
  StepStone: 'StepStone',
  Greenhouse: 'Greenhouse',
  Ashby: 'Ashby',
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
  return n === 1 ? 'Applied' : n === 2 ? "Won't Apply" : 'Not Applied';
}

export function getAppliedTone(value: unknown): string {
  const n = Number(value);
  if (n === 1) return 'bg-emerald-600 text-white';
  if (n === 2) return 'bg-red-600 text-white';
  return 'border border-gray-200 bg-gray-50 text-gray-300';
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

export function getButtonVariant(actionMeaning: unknown): string {
  const key = String(actionMeaning ?? '').trim().toLowerCase();
  if (['execute', 'execution', 'completion', 'apply', 'applied', 'run-once'].includes(key)) return 'primary-green';
  if (['configure', 'configuration', 'confirm', 'confirmation', 'save', 'schedule', 'filter'].includes(key)) return 'primary-blue';
  if (['danger', 'destructive', 'delete', 'stop'].includes(key)) return 'danger-red';
  if (['popup', 'drilldown', 'details', 'source', 'compare', 'costs'].includes(key)) return 'text-link';
  return 'secondary-gray';
}

export function getButtonClass(actionMeaning: unknown): string {
  const variant = getButtonVariant(actionMeaning);
  const base = 'inline-flex items-center justify-center gap-2 text-sm font-medium rounded-lg transition-colors';
  if (variant === 'primary-green') return `${base} bg-emerald-600 hover:bg-emerald-700 text-white`;
  if (variant === 'primary-blue') return `${base} bg-blue-600 hover:bg-blue-700 text-white`;
  if (variant === 'danger-red') return `${base} bg-red-600 hover:bg-red-700 text-white`;
  if (variant === 'text-link') return 'inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline';
  return `${base} bg-gray-100 hover:bg-gray-200 text-gray-700`;
}

export function renderPageHeader(title: unknown, subtitle?: unknown, actionsHtml = ''): string {
  const subtitleHtml = subtitle
    ? `<p class="text-sm text-gray-500 mt-1">${escapeHtml(subtitle)}</p>`
    : '';
  const actions = actionsHtml
    ? `<div class="flex items-center gap-2 flex-shrink-0">${actionsHtml}</div>`
    : '';
  return `<div class="flex items-center justify-between gap-4 mb-6"><div><h1 class="text-2xl font-bold text-gray-900">${escapeHtml(title)}</h1>${subtitleHtml}</div>${actions}</div>`;
}

export function renderActionButton(label: unknown, actionMeaning: unknown, attrs: HtmlAttrs = {}): string {
  const className = `${getButtonClass(actionMeaning)} px-4 py-2 ${attrs.class ?? ''}`.trim();
  const htmlAttrs = attrsToHtml({ ...attrs, class: className });
  return `<button ${htmlAttrs}>${escapeHtml(label)}</button>`;
}

export function renderTextActionLink(label: unknown, href: unknown, attrs: HtmlAttrs = {}): string {
  const className = `text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline ${attrs.class ?? ''}`.trim();
  const htmlAttrs = attrsToHtml({ href, ...attrs, class: className });
  return `<a ${htmlAttrs}>${escapeHtml(label)}</a>`;
}

export function renderDottedPopupLink(label: unknown, attrs: HtmlAttrs = {}): string {
  const className = `text-sm font-semibold text-gray-700 underline decoration-dotted underline-offset-4 hover:text-blue-700 ${attrs.class ?? ''}`.trim();
  const htmlAttrs = attrsToHtml({ type: 'button', ...attrs, class: className });
  return `<button ${htmlAttrs}>${escapeHtml(label)}</button>`;
}

export function renderVerdictChip(value: unknown, options: { editable?: boolean; rounded?: boolean } = {}): string {
  const editable = options.editable ?? false;
  const label = `${formatVerdictLabel(value)}${editable && isVerdictEditable(value) ? ' ▾' : ''}`;
  return `<span class="inline-flex h-7 items-center justify-center rounded-lg px-2 text-xs font-medium ${getVerdictTone(value)} whitespace-nowrap">${escapeHtml(label)}</span>`;
}

export function renderVerdictSelector(value: unknown, attrs: HtmlAttrs = {}): string {
  if (!isVerdictEditable(value)) return renderVerdictChip(value);
  const className = `verdict-btn ${attrs.class ?? ''}`.trim();
  const htmlAttrs = attrsToHtml({ ...attrs, class: className });
  return `<button ${htmlAttrs}>${renderVerdictChip(value, { editable: true, rounded: attrs['data-chip-style'] === 'detail' })}</button>`;
}

export function renderAppliedStatus(value: unknown): string {
  return `<span class="inline-flex h-7 items-center justify-center rounded-lg px-2 text-xs font-medium border ${getAppliedTone(value)} whitespace-nowrap">${formatAppliedLabel(value)}</span>`;
}

export function renderAppliedChip(value: unknown, options: { editable?: boolean; full?: boolean } = {}): string {
  const caret = options.editable ? ' ▾' : '';
  const width = options.full ? 'w-full' : 'w-24';
  return `<span class="${width} inline-flex h-7 items-center justify-center rounded-lg px-2 text-xs font-medium ${getAppliedTone(value)} whitespace-nowrap">${formatAppliedLabel(value)}${caret}</span>`;
}

export function renderAppliedSelector(value: unknown, attrs: HtmlAttrs = {}): string {
  const full = attrs['data-chip-style'] === 'detail';
  const state = Number(value) === 1 ? 1 : Number(value) === 2 ? 2 : 0;
  const className = `applied-btn ${full ? 'w-full ' : ''}cursor-pointer ${attrs.class ?? ''}`.trim();
  const htmlAttrs = attrsToHtml({ type: 'button', 'data-applied': String(state), ...attrs, class: className });
  return `<button ${htmlAttrs}>${renderAppliedChip(value, { editable: true, full })}</button>`;
}

export function renderScoreCell(value: unknown): string {
  const num = Number(value);
  const tone = Number.isFinite(num) && num >= 71 ? 'text-white score-badge-match' : 'text-gray-500 bg-gray-100';
  return `<span class="inline-flex items-center justify-center rounded-lg px-2.5 py-1 text-sm font-semibold score-badge ${tone}">${formatScore(value)}</span>`;
}

export function renderDateTimeCell(value: unknown, timezone = 'UTC'): string {
  return `<span class="text-xs text-gray-500 whitespace-nowrap">${escapeHtml(formatDateTimeToMinutes(value, timezone))}</span>`;
}

export function renderSourceLinkCell(url: unknown, source: unknown = 'Source'): string {
  if (url == null || url === '') return '<span class="text-xs text-gray-300">—</span>';
  const label = formatSourceLabel(source);
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="Open ${escapeHtml(label)}" aria-label="Open ${escapeHtml(label)}" class="source-link-cell inline-flex h-7 w-7 items-center justify-center rounded-lg text-blue-600 hover:bg-blue-50 hover:text-blue-800 transition-colors"><svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 17L17 7M9 7h8v8"/></svg></a>`;
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

export function renderLocationCell(location: unknown, country?: string | null, locationLabels?: string[]): string {
  const primary = (locationLabels && locationLabels.length > 0) ? locationLabels[0] : location;
  if (!primary) return '<span class="text-xs text-gray-300">—</span>';
  const extra = locationLabels && locationLabels.length > 1 ? locationLabels.length - 1 : 0;
  const badge = extra > 0 ? ` <span class="text-gray-400">+${extra}</span>` : '';
  const flag = countryToFlag(country);
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

export function renderRunStatusCounts(run: Record<string, unknown>): string {
  return getRunStatusCounts(run)
    .filter((count) => count.value > 0 || ['strong', 'weak', 'no_match', 'duplicate', 'filtered'].includes(count.key))
    .map((count) => `<span><span class="font-medium">${escapeHtml(count.value)}</span> ${escapeHtml(count.label.toLowerCase())}</span>`)
    .join('<span class="text-gray-300">·</span>');
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
    { key: 'strong', label: 'Strong', value: Number(run.jobs_strong_match ?? 0), tone: getVerdictTone('STRONG_MATCH') },
    { key: 'weak', label: 'Weak', value: Number(run.jobs_weak_match ?? 0), tone: getVerdictTone('WEAK_MATCH') },
    { key: 'no_match', label: 'No match', value: Number(run.jobs_no_match ?? 0), tone: getVerdictTone('NO_MATCH') },
    { key: 'duplicate', label: 'Duplicate', value: Number(run.jobs_duplicate ?? 0), tone: getVerdictTone('DUPLICATE') },
    { key: 'filtered', label: 'Filtered', value: Number(run.filtered_count ?? 0), tone: getVerdictTone('FILTERED') },
    { key: 'blacklisted', label: 'Blacklisted', value: Number(run.blacklisted_count ?? 0), tone: getVerdictTone('BLACKLISTED') },
  ];
}

export function formatRunCost(value: unknown): string {
  if (value == null || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `$${num.toFixed(4)}`;
}

export function getRunHeaderActions(run: Record<string, unknown>) {
  return [{ key: 'costs', label: '$', variant: getButtonVariant('costs'), runId: run.id }];
}

export function getPageHeaderActions(page: unknown) {
  return page === 'run-logs'
    ? [{ key: 'compare-last-2', label: 'Compare last 2 runs', href: '/run-diff', variant: getButtonVariant('compare') }]
    : [];
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
  };
}

export const uiHelpers = {
  escapeHtml,
  formatVerdictLabel,
  getVerdictTone,
  isVerdictEditable,
  formatScore,
  formatAppliedLabel,
  getAppliedTone,
  formatDateTimeToMinutes,
  formatSourceLabel,
  formatSourceName,
  getButtonVariant,
  getButtonClass,
  renderPageHeader,
  renderActionButton,
  renderTextActionLink,
  renderDottedPopupLink,
  renderVerdictChip,
  renderVerdictSelector,
  renderAppliedStatus,
  renderAppliedSelector,
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
  renderJobTableHeader,
  renderJobsAllColgroup,
  renderJobsAllTableHeader,
  renderRunStatusCounts,
  getJobRowColumns,
  getMobileJobCardLayout,
  getRunStatusCounts,
  formatRunCost,
  getRunHeaderActions,
  getPageHeaderActions,
  truncateTextClass,
  getResponsiveListMode,
  getClientUiTokens,
  countryToFlag,
  renderCompanyLogo,
};
