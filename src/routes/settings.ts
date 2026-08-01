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
import { getCanonicalCountries } from '../pipeline/locationNormalizer';
import { emailFrame } from '../pipeline/emailReport';
import { hashToken } from './auth';
import { COMPANY_ENRICHMENT_PROMPT } from '../pipeline/companyEnrichment';

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

// Per-block AI saves are submitted via fetch and expect JSON back, not a redirect/re-render.
function isXhr(req: Request): boolean {
  return req.get('X-Requested-With') === 'fetch';
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
  const validTabs = ['profile', 'roles', 'ai'];
  const activeTab = validTabs.includes(String(req.query.tab)) ? String(req.query.tab) : 'profile';

  const latestGroup    = db.prepare('SELECT MAX(updated_at) as t FROM search_groups WHERE profile_id = ?').get(profileId) as { t: string | null };
  const latestCv       = db.prepare('SELECT MAX(uploaded_at) as t FROM cvs WHERE profile_id = ?').get(profileId) as { t: string | null };
  const latestBlacklist = db.prepare('SELECT MAX(created_at) as t FROM blacklisted_companies WHERE profile_id = ?').get(profileId) as { t: string | null };
  const rolesTimestamps = [latestGroup.t, latestCv.t, latestBlacklist.t].filter(Boolean) as string[];
  const rolesLastSaved  = rolesTimestamps.length > 0 ? rolesTimestamps.sort().at(-1)! : null;

  const locationCountries = getCanonicalCountries();

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
    isAdmin: req.profile.isAdmin,
    profileEmail: req.profile.email,
    pendingEmailChange: getPendingEmailChange(db, profileId),
    locationCountries,
    companyEnrichmentPrompt: COMPANY_ENRICHMENT_PROMPT,
    pageMaxWidth: '48rem',
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
      const section = String(body.section || 'email');
      if (section === 'keys') {
        const newApify = String(body.apify_api_token || '').trim();
        const newOpenAi = String(body.openai_api_key || '').trim();
        const sets: string[] = ['updated_at = ?'];
        const vals: unknown[] = [now];
        if (newApify) { sets.unshift('apify_api_token = ?'); vals.unshift(newApify); }
        if (newOpenAi) { sets.unshift('openai_api_key = ?'); vals.unshift(newOpenAi); }
        db.prepare(`UPDATE settings SET ${sets.join(', ')} WHERE profile_id = ?`).run(...vals, profileId);
      } else {
        const emailFields: Array<[string, unknown]> = [
          ['email_from', String(body.email_from || '')],
          ['app_url', String(body.app_url || '')],
          ['updated_at', now],
        ];
        const newResend = String(body.resend_api_key || '').trim();
        if (newResend) emailFields.unshift(['resend_api_key', newResend]);
        db.prepare(
          `UPDATE settings SET ${emailFields.map(([c]) => `${c} = ?`).join(', ')} WHERE profile_id = ?`
        ).run(...emailFields.map(([, v]) => v), profileId);
      }
      res.redirect('/admin?tab=general&saved=1');
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
          subject: 'Confirm your new email address — Job Search',
          html: emailFrame('brand', `
      <h3 style="margin:0 0 14px;font-size:17px;font-weight:800;color:#131722;letter-spacing:-0.01em;">Confirm email change</h3>
      <p style="color:#3a4250;font-size:14px;line-height:1.6;margin:0 0 20px;">
        Click the button below to confirm <strong>${newEmail}</strong> as your new login address. This link expires in 24 hours.
      </p>
      <a href="${confirmUrl}" style="display:inline-block;background:#4373ff;color:#fff;text-decoration:none;padding:11px 20px;border-radius:11px;font-size:14px;font-weight:700;">
        Confirm new email
      </a>
      <p style="color:#8a91a0;font-size:12px;line-height:1.6;margin:20px 0 0;">
        If you didn't request this, ignore this email — your address won't change.
      </p>`),
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
          ['profile_description', String(body.profile_description || '')],
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
        ['profile_description', String(body.profile_description || '')],
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
      const newDedup = String(body.dedup_system_prompt || '').trim();
      const newSummary = String(body.summary_prompt || '').trim();
      const newCvPrompt = String(body.cv_comparison_prompt || '').trim();
      const newUserApify = String(body.user_apify_api_token || '').trim();
      const newUserOpenAi = String(body.user_openai_api_key || '').trim();
      // Each AI block posts its own form, so only update the columns actually submitted —
      // an absent field means "not edited", not "reset to default".
      const aiFields: Array<[string, unknown]> = [
        ['ai_updated_at', now],
        ['updated_at', now],
      ];
      if ('ai_model' in body) aiFields.push(['ai_model', String(body.ai_model)]);
      if ('ai_model_hard' in body) aiFields.push(['ai_model_hard', String(body.ai_model_hard)]);
      if ('use_jh_credits' in body) aiFields.push(['use_jh_credits', body.use_jh_credits === '0' ? 0 : 1]);
      if (newDedup) aiFields.push(['dedup_system_prompt', newDedup]);
      if (newSummary) aiFields.push(['summary_prompt', newSummary]);
      if (newCvPrompt) aiFields.push(['cv_comparison_prompt', newCvPrompt]);
      if (newUserApify) aiFields.push(['user_apify_api_token', newUserApify]);
      if (newUserOpenAi) aiFields.push(['user_openai_api_key', newUserOpenAi]);
      db.prepare(
        `UPDATE settings SET ${aiFields.map(([c]) => `${c} = ?`).join(', ')} WHERE profile_id = ?`
      ).run(...aiFields.map(([, v]) => v), profileId);
    }

    if (isXhr(req)) {
      res.json({ success: true, saved_at: now });
      return;
    }
    res.redirect(`/settings?tab=${tab}&saved=1`);
  } catch (err) {
    if (isXhr(req)) {
      res.status(400).json({ success: false, error: (err as Error).message });
      return;
    }
    const settings = db.prepare('SELECT * FROM settings WHERE profile_id = ?').get(profileId) as SettingsRow;
    const tab = String((req.body as Record<string, string>).tab || 'profile');
    const locationCountries = getCanonicalCountries();
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
      locationCountries,
      pageMaxWidth: '852px',
      stgFrame: true,
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
    db.prepare('DELETE FROM sessions WHERE profile_id = ? AND token != ?').run(req.profile.id, hashToken(currentToken));
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
    const locationCountries = getCanonicalCountries();
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
      locationCountries,
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
