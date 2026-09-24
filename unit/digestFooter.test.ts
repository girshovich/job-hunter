/**
 * The digest email footer (donations.md §4.4): maker credit, contact marks and the Hipolink line.
 *
 * `buildEmailHtml` is a pure function of its arguments, so it is asserted directly — no send, no
 * browser. The two cases are the two footers it can draw: with a base URL the contacts are hosted
 * PNG marks (Gmail strips SVG); without one there is nowhere to host them, so they are text links.
 *
 *   npm run test:unit
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmailHtml, emailFooterSenderHtml, emailFrame } from '../src/pipeline/emailReport';

// Built like the `mockStats` literal in `sendTestEmail`.
const stats: Parameters<typeof buildEmailHtml>[1] = {
  jobsFetched: 42,
  jobsScored: 38,
  strongMatch: 5,
  weakMatch: 12,
  noMatch: 21,
  duplicates: 2,
  filtered: 3,
  blacklisted: 1,
};

test('with a base URL: credit, hosted PNG marks with alt text, Hipolink line', () => {
  const html = buildEmailHtml([], stats, 'Today', 'https://anotherjob.app');
  assert.ok(html.includes('<a href="https://anotherjob.app"'));
  assert.ok(html.includes('>anotherjob.app</a> · by Mikhail Girshovich'));
  assert.ok(!html.includes('Sent by'));
  assert.ok(html.includes('https://anotherjob.app/email/linkedin.png'));
  assert.ok(html.includes('alt="LinkedIn"'));
  assert.ok(html.includes('https://anotherjob.app/email/mail.png'));
  assert.ok(html.includes('alt="Email"'));
  assert.ok(html.includes('href="https://hipolink.net/girshovich/tips"'));
  assert.ok(html.includes('&#9829; Support the project'));
});

test('transactional footer links the configured site domain', () => {
  const html = emailFrame('brand', '<p>Test</p>', 'https://anotherjob.app/app');
  assert.ok(html.includes('Sent by <a href="https://anotherjob.app/app"'));
  assert.ok(html.includes('>anotherjob.app</a>'));
});

test('transactional footer keeps the plain fallback for an invalid site URL', () => {
  assert.equal(emailFooterSenderHtml('javascript:alert(1)'), 'Job Search');
  assert.ok(emailFrame('brand', '<p>Test</p>', '').includes('Sent by Job Search'));
});

test('without a base URL: no images, text links instead, Hipolink line kept', () => {
  const html = buildEmailHtml([], stats, 'Today', '');
  assert.ok(html.includes('Job Search · by Mikhail Girshovich'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('>LinkedIn</a>'));
  assert.ok(html.includes('>Email</a>'));
  assert.ok(html.includes('href="mailto:mikhail@girshovich.me"'));
  assert.ok(html.includes('href="https://hipolink.net/girshovich/tips"'));
  assert.ok(html.includes('&#9829; Support the project'));
});
