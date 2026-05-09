/**
 * Settings Routes — Global settings only (AI model, score thresholds, email, cron).
 * Per-location config (keywords, filters, AI prompt) is managed via /api/groups.
 */

import * as path from 'path';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { getDb, type SettingsRow, type SearchGroupRow, type CvRow } from '../db';

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

router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;
  const settings = db.prepare('SELECT * FROM settings WHERE profile_id = ?').get(profileId) as SettingsRow;
  const saved = req.query.saved === '1';
  const activeTab = ['profile', 'roles', 'ai'].includes(String(req.query.tab)) ? String(req.query.tab) : 'profile';

  const latestGroup = db.prepare('SELECT MAX(updated_at) as t FROM search_groups WHERE profile_id = ?').get(profileId) as { t: string | null };
  const latestCv = db.prepare('SELECT MAX(uploaded_at) as t FROM cvs WHERE profile_id = ?').get(profileId) as { t: string | null };
  const latestBlacklist = db.prepare('SELECT MAX(created_at) as t FROM blacklisted_companies WHERE profile_id = ?').get(profileId) as { t: string | null };
  const rolesTimestamps = [latestGroup.t, latestCv.t, latestBlacklist.t].filter(Boolean) as string[];
  const rolesLastSaved = rolesTimestamps.length > 0 ? rolesTimestamps.sort().at(-1)! : null;

  res.render('settings', { settings, groups: getGroups(db, profileId), cvs: getCvs(db, profileId), title: 'Settings', saved, error: null, activeTab, rolesLastSaved });
});

router.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;

  try {
    const body = req.body as Record<string, string | string[]>;
    const tab = (['profile', 'ai'] as string[]).includes(String(body.tab)) ? String(body.tab) : 'profile';
    const now = new Date().toISOString();

    if (tab === 'profile') {
      db.prepare(`
        UPDATE settings SET
          email_recipient = ?,
          resend_api_key = ?,
          email_from = ?,
          email_enabled = ?,
          timezone = ?,
          languages = ?,
          current_location = ?,
          profile_updated_at = ?,
          updated_at = ?
        WHERE profile_id = ?
      `).run(
        String(body.email_recipient || ''),
        String(body.resend_api_key || ''),
        String(body.email_from || ''),
        (body.email_enabled === 'on' || body.email_enabled === '1') ? 1 : 0,
        String(body.timezone || 'UTC'),
        String(body.languages || ''),
        String(body.current_location || ''),
        now,
        now,
        profileId,
      );
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
    res.status(400).render('settings', {
      settings,
      groups: getGroups(db, profileId),
      cvs: getCvs(db, profileId),
      title: 'Settings',
      saved: false,
      error: (err as Error).message,
      activeTab: tab,
      rolesLastSaved: null,
    });
  }
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
    res.status(400).render('settings', {
      settings,
      groups: getGroups(db, profileId),
      cvs: getCvs(db, profileId),
      title: 'Settings',
      saved: false,
      error: 'No file provided or file type not allowed (PDF, TXT, MD only).',
      activeTab: 'roles',
      rolesLastSaved: null,
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
