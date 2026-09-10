/** Playwright `globalSetup` — see tests/activity.ts. */
import { snapshotActivity } from './activity';

export default function globalSetup(): void {
  snapshotActivity();
}
