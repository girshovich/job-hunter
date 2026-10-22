/**
 * Optional Indeed search adapter. Offline: no Apify call.
 *
 *   npm run test:unit
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actorCountry,
  actorDatePosted,
  buildIndeedSearchInput,
  mapIndeedSearchItem,
} from '../src/pipeline/providers/indeed-search';
import { DEFAULT_PROVIDER_SELECTION } from '../src/db';

test('the input uses this repo\'s keyword, location, and 24h window', () => {
  const body = buildIndeedSearchInput('Product Manager', 'London', 'uk', '24h');
  assert.deepEqual(body, {
    mode: 'search',
    keywords: ['Product Manager'],
    location: 'London',
    country: 'GB',
    datePosted: 'Last 24 hours',
    maxResultsPerInput: 100,
    uniqueJobsOnly: true,
  });
  assert.equal(actorCountry('uk'), 'GB');
  assert.equal(actorDatePosted('7d'), 'Last 7 days');
  assert.equal(actorDatePosted('month'), '');
  assert.equal(buildIndeedSearchInput('Product Manager', 'London', 'uk', 'month').datePosted, '');
});

test('a job row maps onto the existing posting fields and a non-job row is dropped', () => {
  const job = mapIndeedSearchItem({
    result_type: 'job',
    jobId: 'example-job-1',
    jobTitle: 'Product Manager',
    jobUrl: 'https://uk.indeed.com/viewjob?jk=example',
    applyUrl: 'https://example.com/apply/example-job-1',
    companyName: 'Example Co',
    location: 'London',
    city: 'London',
    descriptionMarkdown: 'Own the roadmap.',
    datePosted: '2026-10-21',
    companyLogo: 'https://example.com/logo.png',
    salaryMin: 80000,
    salaryMax: 90000,
    salaryPeriod: 'YEARLY',
    salaryCurrency: 'GBP',
    isRemote: true,
    workModel: 'Hybrid',
  });
  assert.ok(job);
  assert.equal(job.jobId, 'example-job-1');
  assert.equal(job.title, 'Product Manager');
  assert.equal(job.company, 'Example Co');
  assert.equal(job.location, 'London');
  assert.equal(job.url, 'https://uk.indeed.com/viewjob?jk=example');
  assert.equal(job.applyUrl, 'https://example.com/apply/example-job-1');
  assert.equal(job.description, 'Own the roadmap.');
  assert.equal(job.postedDate, '2026-10-21');
  assert.equal(job.workMode, 'Hybrid');
  assert.equal(job.salary, '80,000 - 90,000 GBP / year');
  assert.equal(job.logoUrl, 'https://example.com/logo.png');
  assert.equal(job.provider, 'indeed-search');
  assert.equal(job.jobSource, 'Indeed');
  assert.equal(mapIndeedSearchItem({ result_type: 'other', jobId: 'notice' }), null);
  assert.equal(mapIndeedSearchItem({ result_type: 'job' }), null);
  const remote = mapIndeedSearchItem({
    result_type: 'job',
    jobId: 'example-job-2',
    jobTitle: 'Product Manager',
    jobUrl: 'https://uk.indeed.com/viewjob?jk=example-2',
    isRemote: true,
  });
  assert.equal(remote?.workMode, 'Remote');
});

test('the new provider is not part of the default selection', () => {
  const defaults: readonly string[] = DEFAULT_PROVIDER_SELECTION;
  assert.equal(defaults.includes('indeed-search'), false);
  assert.equal(defaults.includes('valig'), true);
});
