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
} as const;
