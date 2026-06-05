import { Router, type Request, type Response, type NextFunction } from 'express';
import { config } from '../config';
import { getDb, type SessionRow } from '../db';

const PUBLIC_PAGE_META = {
  '/pricing': { view: 'public/pricing', standaloneView: 'public/standalone-pricing', title: 'Pricing' },
  '/terms': { view: 'public/terms', standaloneView: 'public/standalone-terms', title: 'Terms' },
  '/privacy': { view: 'public/privacy', standaloneView: 'public/standalone-privacy', title: 'Privacy' },
  '/refunds': { view: 'public/refunds', standaloneView: 'public/standalone-refunds', title: 'Refunds' },
} as const;

const PUBLIC_PATHS = Object.keys(PUBLIC_PAGE_META) as Array<keyof typeof PUBLIC_PAGE_META>;
const EFFECTIVE_DATE = 'June 5, 2026';

function extractSupportEmail(raw: string): string {
  const match = String(raw || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0] || 'support@example.com';
}

function hasValidSession(req: Request): boolean {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)jh_session=([^;]+)/);
  if (!match) return false;

  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(match[1]) as SessionRow | undefined;
  if (!session || new Date(session.expires_at) < new Date()) {
    return false;
  }

  const profileExists = db.prepare('SELECT 1 as ok FROM profiles WHERE id = ?').get(session.profile_id) as { ok: number } | undefined;
  return !!profileExists;
}

function renderPublicPage(req: Request, res: Response, next: NextFunction): void {
  const path = req.path as keyof typeof PUBLIC_PAGE_META;
  const meta = PUBLIC_PAGE_META[path];
  if (!meta) {
    next();
    return;
  }

  const locals = {
    title: meta.title,
    supportEmail: extractSupportEmail(config.emailFrom),
    effectiveDate: EFFECTIVE_DATE,
  };

  if (hasValidSession(req)) {
    next();
    return;
  }

  res.render(meta.standaloneView, locals);
}

const publicAnonymousRouter = Router();
for (const path of PUBLIC_PATHS) {
  publicAnonymousRouter.get(path, renderPublicPage);
}

const publicAuthedRouter = Router();
for (const path of PUBLIC_PATHS) {
  const meta = PUBLIC_PAGE_META[path];
  publicAuthedRouter.get(path, (_req: Request, res: Response) => {
    res.render(meta.view, {
      title: meta.title,
      supportEmail: extractSupportEmail(config.emailFrom),
      effectiveDate: EFFECTIVE_DATE,
    });
  });
}

export { publicAnonymousRouter, publicAuthedRouter };
