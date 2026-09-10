import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export const config = {
  apifyApiToken: process.env.APIFY_API_TOKEN || '',
  openAiKey: process.env.OPENAI_API_KEY || '',
  resendApiKey: process.env.RESEND_API_KEY || '',
  emailFrom: process.env.EMAIL_FROM || '',
  port: parseInt(process.env.PORT || '3000', 10),
  dbPath: process.env.DATABASE_PATH || './data/jobs.db',
  // The abandoned-schedule reaper ships in shadow mode: it logs what it would pause and touches
  // nothing until this is set to '1' (schedule_disable.md §9).
  scheduleReaperEnforce: process.env.SCHEDULE_REAPER_ENFORCE === '1',
} as const;
