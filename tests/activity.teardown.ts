/** Playwright `globalTeardown` — see tests/activity.ts. */
import { restoreActivity } from './activity';

export default function globalTeardown(): void {
  restoreActivity();
}
