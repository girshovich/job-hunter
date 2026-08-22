/**
 * Fetcher — scraping provider orchestrator.
 * Re-exports shared types; routes fetch requests to the active provider.
 */

export type { JobPosting, SearchFilters, DateRange, FetchResult } from './types';
import type { SearchFilters, DateRange, FetchResult } from './types';
import { fetchWithHarvestApi } from './providers/harvestapi';
import { fetchWithValig, type ValigFetchOptions } from './providers/valig';
import { fetchWithStepStone }  from './providers/stepstone';
import { fetchWithIndeed }     from './providers/indeed';
import { fetchWithGreenhouse } from './providers/greenhouse';
import { fetchWithAshby }      from './providers/ashby';
import { fetchWithLever }      from './providers/lever';
import { fetchWithTelegram }   from './providers/telegram';

export async function fetchJobs(
  filters: SearchFilters,
  apifyToken: string,
  dateRange: DateRange = '24h',
  provider = 'harvestapi',
  valigOptions: ValigFetchOptions = {},
): Promise<FetchResult> {
  if (provider === 'valig')      return fetchWithValig(filters, apifyToken, dateRange, valigOptions);
  if (provider === 'indeed')     return fetchWithIndeed(filters, apifyToken, dateRange);
  if (provider === 'stepstone')  return fetchWithStepStone(filters, apifyToken, dateRange);
  if (provider === 'greenhouse') return fetchWithGreenhouse(filters, apifyToken, dateRange);
  if (provider === 'ashby')      return fetchWithAshby(filters, apifyToken, dateRange);
  if (provider === 'lever')      return fetchWithLever(filters, apifyToken, dateRange);
  if (provider === 'telegram')   return fetchWithTelegram(filters, apifyToken, dateRange);
  return fetchWithHarvestApi(filters, apifyToken, dateRange);
}
