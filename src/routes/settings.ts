/**
 * Settings Routes — Global settings only (AI model, score thresholds, email, cron).
 * Per-location config (keywords, filters, AI prompt) is managed via /api/groups.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { Resend } from 'resend';
import { getDb, type SettingsRow, type SearchGroupRow, type CvRow, type EmailChangeRequestRow } from '../db';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const allowedMimes = ['application/pdf', 'text/plain', 'text/markdown'];
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.pdf', '.txt', '.md'];
    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, TXT, and MD files are allowed'));
    }
  },
});

function getGroups(db: ReturnType<typeof getDb>, profileId: number): SearchGroupRow[] {
  return db.prepare('SELECT * FROM search_groups WHERE profile_id = ? ORDER BY id ASC').all(profileId) as SearchGroupRow[];
}

function getCvs(db: ReturnType<typeof getDb>, profileId: number): Omit<CvRow, 'content_b64'>[] {
  return db.prepare('SELECT id, profile_id, filename, mime_type, file_size, uploaded_at FROM cvs WHERE profile_id = ? ORDER BY uploaded_at DESC').all(profileId) as Omit<CvRow, 'content_b64'>[];
}

function getPendingEmailChange(db: ReturnType<typeof getDb>, profileId: number): EmailChangeRequestRow | null {
  return (db.prepare(
    'SELECT * FROM email_change_requests WHERE profile_id = ? AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1'
  ).get(profileId, new Date().toISOString()) as EmailChangeRequestRow | undefined) ?? null;
}

function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (ch) => {
    switch (ch) {
      case '<': return '\\u003c';
      case '>': return '\\u003e';
      case '&': return '\\u0026';
      case '\u2028': return '\\u2028';
      case '\u2029': return '\\u2029';
      default: return ch;
    }
  });
}

router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;
  const settings = db.prepare('SELECT * FROM settings WHERE profile_id = ?').get(profileId) as SettingsRow;
  const groups = getGroups(db, profileId);
  const cvs = getCvs(db, profileId);
  const saved = req.query.saved === '1';
  const validTabs = req.profile.isAdmin ? ['profile', 'roles', 'ai', 'admin'] : ['profile', 'roles', 'ai'];
  const activeTab = validTabs.includes(String(req.query.tab)) ? String(req.query.tab) : 'profile';

  const latestGroup    = db.prepare('SELECT MAX(updated_at) as t FROM search_groups WHERE profile_id = ?').get(profileId) as { t: string | null };
  const latestCv       = db.prepare('SELECT MAX(uploaded_at) as t FROM cvs WHERE profile_id = ?').get(profileId) as { t: string | null };
  const latestBlacklist = db.prepare('SELECT MAX(created_at) as t FROM blacklisted_companies WHERE profile_id = ?').get(profileId) as { t: string | null };
  const rolesTimestamps = [latestGroup.t, latestCv.t, latestBlacklist.t].filter(Boolean) as string[];
  const rolesLastSaved  = rolesTimestamps.length > 0 ? rolesTimestamps.sort().at(-1)! : null;

  const allProfiles = req.profile.isAdmin
    ? (db.prepare('SELECT id, email, is_admin, created_at FROM profiles ORDER BY id ASC').all() as Array<{ id: number; email: string; is_admin: number; created_at: string }>)
    : [];

  const errorParam = String(req.query.error || '');
  const queryError = errorParam === 'email-taken-on-confirm'
    ? 'That email is already in use by another account. Email change cancelled.'
    : null;
  const notice = req.query.message === 'email-changed'
    ? 'Email address updated successfully.'
    : null;

  res.render('settings', {
    settings,
    groups,
    groupsJson: jsonForInlineScript(groups),
    cvs,
    title: 'Settings',
    saved,
    error: queryError,
    notice,
    activeTab,
    rolesLastSaved,
    allProfiles,
    isAdmin: req.profile.isAdmin,
    profileEmail: req.profile.email,
    pendingEmailChange: getPendingEmailChange(db, profileId),
    pageMaxWidth: '48rem',
  });
});

router.get('/unresolved-locations', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) {
    res.status(403).send('Forbidden');
    return;
  }

  const db = getDb();
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const perPage = 50;
  const q = String(req.query.q || '').trim();
  const offset = (page - 1) * perPage;
  const whereSearch = q ? `AND LOWER(j.location) LIKE ?` : '';
  const params = q ? [`%${q.toLowerCase()}%`] : [];

  const total = (db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT j.location
      FROM jobs j
      JOIN location_country lc ON lc.location = j.location AND lc.country = ''
      WHERE j.job_source IN ('Greenhouse', 'Ashby')
        AND j.location IS NOT NULL
        AND j.country IS NULL
        ${whereSearch}
      GROUP BY j.location
    )
  `).get(...params) as { c: number }).c;

  const rows = db.prepare(`
    SELECT j.location,
           COUNT(*) AS job_count,
           GROUP_CONCAT(DISTINCT j.job_source) AS providers,
           MAX(lc.created_at) AS last_checked
    FROM jobs j
    JOIN location_country lc ON lc.location = j.location AND lc.country = ''
    WHERE j.job_source IN ('Greenhouse', 'Ashby')
      AND j.location IS NOT NULL
      AND j.country IS NULL
      ${whereSearch}
    GROUP BY j.location
    ORDER BY job_count DESC, j.location ASC
    LIMIT ? OFFSET ?
  `).all(...params, perPage, offset) as Array<{
    location: string;
    job_count: number;
    providers: string;
    last_checked: string;
  }>;

  const exampleStmt = db.prepare(`
    SELECT company, title, job_source
    FROM jobs
    WHERE job_source IN ('Greenhouse', 'Ashby')
      AND location = ?
      AND country IS NULL
    ORDER BY fetched_at DESC
    LIMIT 3
  `);
  const locations = rows.map((row) => ({
    ...row,
    examples: exampleStmt.all(row.location) as Array<{ company: string; title: string; job_source: string }>,
  }));

  res.render('unresolved-locations', {
    title: 'Unresolved Locations',
    locations,
    total,
    page,
    perPage,
    q,
    pageCount: Math.max(1, Math.ceil(total / perPage)),
  });
});

router.post('/', async (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;

  try {
    const body = req.body as Record<string, string | string[]>;
    const tab = (['profile', 'ai', 'admin'] as string[]).includes(String(body.tab)) ? String(body.tab) : 'profile';
    const now = new Date().toISOString();

    if (tab === 'admin') {
      if (!req.profile.isAdmin) {
        res.status(403).send('Forbidden');
        return;
      }
      db.prepare(`UPDATE settings SET email_from = ?, resend_api_key = ?, updated_at = ? WHERE profile_id = ?`).run(
        String(body.email_from || ''),
        String(body.resend_api_key || ''),
        now,
        profileId,
      );
      res.redirect('/settings?tab=admin&saved=1');
      return;
    }

    if (tab === 'profile') {
      const isAdmin = req.profile.isAdmin;

      // Handle email change — send confirmation to new address instead of applying immediately
      const newEmail = String(body.profile_email || '').trim().toLowerCase();
      if (newEmail && newEmail !== req.profile.email) {
        if (!newEmail.includes('@') || !newEmail.includes('.')) {
          throw new Error('Invalid email address.');
        }
        const taken = db.prepare('SELECT id FROM profiles WHERE email = ? AND id != ?').get(newEmail, profileId);
        if (taken) throw new Error('That email is already in use by another account.');

        const adminProfile = db.prepare('SELECT id FROM profiles WHERE is_admin = 1 LIMIT 1').get() as { id: number } | undefined;
        const adminSettings = adminProfile
          ? db.prepare('SELECT resend_api_key, email_from FROM settings WHERE profile_id = ?').get(adminProfile.id) as { resend_api_key: string; email_from: string } | undefined
          : undefined;

        if (!adminSettings?.resend_api_key) {
          throw new Error('Email delivery not configured. Cannot send confirmation email.');
        }

        const changeToken = crypto.randomBytes(32).toString('hex');
        const tokenExpiry = new Date(Date.now() + 24 * 3600000).toISOString();
        const confirmUrl = `${req.protocol}://${req.get('host')}/settings/confirm-email?token=${changeToken}`;
        const resend = new Resend(adminSettings.resend_api_key);
        const from = adminSettings.email_from || 'noreply@example.com';
        const { error: sendErr } = await resend.emails.send({
          from,
          to: newEmail,
          subject: 'Confirm your new email address — Job Hunter',
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 16px;">
              <h2 style="margin:0 0 16px;color:#111827;">Confirm email change</h2>
              <p style="color:#374151;font-size:14px;margin:0 0 24px;">
                Click the button below to confirm <strong>${newEmail}</strong> as your new login address.
                This link expires in 24 hours.
              </p>
              <a href="${confirmUrl}"
                 style="display:inline-block;padding:12px 24px;background:#2563EB;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">
                Confirm new email
              </a>
              <p style="color:#9CA3AF;font-size:12px;margin-top:24px;">
                If you didn't request this, ignore this email — your address won't change.
              </p>
            </div>`,
        });
        if (sendErr) throw new Error(`Failed to send confirmation email: ${sendErr.message}`);

        // Only persist the pending request after a successful send
        db.prepare('DELETE FROM email_change_requests WHERE profile_id = ?').run(profileId);
        db.prepare(
          'INSERT INTO email_change_requests (profile_id, new_email, token, created_at, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)'
        ).run(profileId, newEmail, changeToken, now, tokenExpiry);

        // Save other profile settings, then show pending state
        const updateFields: [string, unknown][] = [
          ['email_enabled', (body.email_enabled === 'on' || body.email_enabled === '1') ? 1 : 0],
          ['timezone', String(body.timezone || 'UTC')],
          ['languages', String(body.languages || '')],
          ['current_location', String(body.current_location || '')],
          ['profile_updated_at', now],
          ['updated_at', now],
        ];
        if (isAdmin && 'resend_api_key' in body) {
          updateFields.push(
            ['resend_api_key', String(body.resend_api_key || '')],
            ['email_from', String(body.email_from || '')],
          );
        }
        const setClauses = updateFields.map(([col]) => `${col} = ?`).join(', ');
        const values = [...updateFields.map(([, v]) => v), profileId];
        db.prepare(`UPDATE settings SET ${setClauses} WHERE profile_id = ?`).run(...values);

        return res.redirect('/settings?tab=profile');
      }

      const updateFields: [string, unknown][] = [
        ['email_enabled', (body.email_enabled === 'on' || body.email_enabled === '1') ? 1 : 0],
        ['timezone', String(body.timezone || 'UTC')],
        ['languages', String(body.languages || '')],
        ['current_location', String(body.current_location || '')],
        ['profile_updated_at', now],
        ['updated_at', now],
      ];

      if (isAdmin && 'resend_api_key' in body) {
        updateFields.push(
          ['resend_api_key', String(body.resend_api_key || '')],
          ['email_from', String(body.email_from || '')],
        );
      }

      const setClauses = updateFields.map(([col]) => `${col} = ?`).join(', ');
      const values = [...updateFields.map(([, v]) => v), profileId];
      db.prepare(`UPDATE settings SET ${setClauses} WHERE profile_id = ?`).run(...values);
    } else {
      db.prepare(`
        UPDATE settings SET
          ai_model = ?,
          ai_model_hard = ?,
          dedup_system_prompt = ?,
          summary_prompt = ?,
          cv_comparison_prompt = ?,
          apify_api_token = ?,
          openai_api_key = ?,
          ai_updated_at = ?,
          updated_at = ?
        WHERE profile_id = ?
      `).run(
        String(body.ai_model || 'gpt-5.4-mini'),
        String(body.ai_model_hard || 'gpt-5.4'),
        String(body.dedup_system_prompt || ''),
        String(body.summary_prompt || ''),
        String(body.cv_comparison_prompt || ''),
        String(body.apify_api_token || ''),
        String(body.openai_api_key || ''),
        now,
        now,
        profileId,
      );
    }

    res.redirect(`/settings?tab=${tab}&saved=1`);
  } catch (err) {
    const settings = db.prepare('SELECT * FROM settings WHERE profile_id = ?').get(profileId) as SettingsRow;
    const tab = String((req.body as Record<string, string>).tab || 'profile');
    const allProfiles = req.profile.isAdmin
      ? (db.prepare('SELECT id, email, is_admin, created_at FROM profiles ORDER BY id ASC').all() as Array<{ id: number; email: string; is_admin: number; created_at: string }>)
      : [];
    res.status(400).render('settings', {
      settings,
      groups: getGroups(db, profileId),
      cvs: getCvs(db, profileId),
      title: 'Settings',
      saved: false,
      error: (err as Error).message,
      notice: null,
      activeTab: tab,
      rolesLastSaved: null,
      allProfiles,
      pageMaxWidth: '48rem',
      isAdmin: req.profile.isAdmin,
      profileEmail: req.profile.email,
      pendingEmailChange: getPendingEmailChange(db, profileId),
    });
  }
});

router.post('/profile-email', (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body as Record<string, string>;
  const newEmail = String(body.email || '').trim().toLowerCase();

  if (!newEmail || !newEmail.includes('@') || !newEmail.includes('.')) {
    return res.redirect('/settings?tab=profile&saved=0&error=invalid-email');
  }

  const existing = db.prepare('SELECT id FROM profiles WHERE email = ? AND id != ?').get(newEmail, req.profile.id);
  if (existing) {
    return res.redirect('/settings?tab=profile&saved=0&error=email-taken');
  }

  db.prepare('UPDATE profiles SET email = ? WHERE id = ?').run(newEmail, req.profile.id);
  db.prepare('UPDATE settings SET email_recipient = ? WHERE profile_id = ?').run(newEmail, req.profile.id);
  // Invalidate all sessions except current
  const currentToken = (req.headers.cookie || '').match(/(?:^|;\s*)jh_session=([^;]+)/)?.[1];
  if (currentToken) {
    db.prepare('DELETE FROM sessions WHERE profile_id = ? AND token != ?').run(req.profile.id, currentToken);
  }

  res.redirect('/settings?tab=profile&saved=1');
});

// Cancel a pending email change
router.post('/cancel-email-change', (req: Request, res: Response) => {
  const db = getDb();
  db.prepare('DELETE FROM email_change_requests WHERE profile_id = ?').run(req.profile.id);
  res.redirect('/settings?tab=profile');
});

// --- CV routes ---

// List CVs (JSON)
router.get('/cvs', (req: Request, res: Response) => {
  const db = getDb();
  res.json({ cvs: getCvs(db, req.profile.id) });
});

// Upload CV
router.post('/cvs/upload', upload.single('cv_file'), (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;

  if (!req.file) {
    const settings = db.prepare('SELECT * FROM settings WHERE profile_id = ?').get(profileId) as SettingsRow;
    const allProfiles = req.profile.isAdmin
      ? (db.prepare('SELECT id, email, is_admin, created_at FROM profiles ORDER BY id ASC').all() as Array<{ id: number; email: string; is_admin: number; created_at: string }>)
      : [];
    res.status(400).render('settings', {
      settings,
      groups: getGroups(db, profileId),
      cvs: getCvs(db, profileId),
      title: 'Settings',
      saved: false,
      error: 'No file provided or file type not allowed (PDF, TXT, MD only).',
      notice: null,
      activeTab: 'roles',
      rolesLastSaved: null,
      allProfiles,
      isAdmin: req.profile.isAdmin,
      profileEmail: req.profile.email,
      pendingEmailChange: getPendingEmailChange(db, profileId),
    });
    return;
  }

  const contentB64 = req.file.buffer.toString('base64');
  db.prepare(`
    INSERT INTO cvs (profile_id, filename, mime_type, content_b64, file_size, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(profileId, req.file.originalname, req.file.mimetype, contentB64, req.file.size, new Date().toISOString());

  res.redirect('/settings?tab=roles');
});

// Delete CV
router.delete('/cvs/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  const cv = db.prepare('SELECT id FROM cvs WHERE id = ? AND profile_id = ?').get(id, req.profile.id);
  if (!cv) {
    res.status(404).json({ error: 'CV not found' });
    return;
  }
  db.prepare('DELETE FROM cvs WHERE id = ?').run(id);
  res.json({ ok: true });
});

// View/open CV file
router.get('/cvs/:id/view', (req: Request, res: Response) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  const cv = db.prepare('SELECT filename, mime_type, content_b64 FROM cvs WHERE id = ? AND profile_id = ?').get(id, req.profile.id) as Pick<CvRow, 'filename' | 'mime_type' | 'content_b64'> | undefined;
  if (!cv) {
    res.status(404).send('Not found');
    return;
  }
  const buffer = Buffer.from(cv.content_b64, 'base64');
  res.setHeader('Content-Type', cv.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${cv.filename}"`);
  res.setHeader('Content-Length', String(buffer.length));
  res.send(buffer);
});

export { router as settingsRouter };
