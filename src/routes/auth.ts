import * as crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import { Resend } from 'resend';
import { getDb, type ProfileRow, type OtpCodeRow, type SessionRow, type EmailChangeRequestRow } from '../db';

export const SESSION_COOKIE = 'jh_session';
export const SESSION_DAYS = 30;

const OTP_MINUTES = 15;

function generateOtp(): string {
  return String(crypto.randomInt(100000, 1000000));
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(db: ReturnType<typeof getDb>, profileId: number): string {
  const token = generateToken();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare(
    'INSERT INTO sessions (token, profile_id, created_at, expires_at, last_active) VALUES (?, ?, ?, ?, ?)'
  ).run(token, profileId, now, expiresAt, now);
  return token;
}

// Returns true if this email is currently rate-limited for OTP sends.
// Trigger: ≥3 codes sent within any 60-second window in the last 5 minutes.
function isResendRateLimited(db: ReturnType<typeof getDb>, email: string): boolean {
  const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
  const recent = db.prepare(
    `SELECT created_at FROM otp_codes WHERE email = ? AND created_at > ? ORDER BY created_at ASC`
  ).all(email, fiveMinAgo) as Array<{ created_at: string }>;

  if (recent.length < 3) return false;

  for (let i = 0; i <= recent.length - 3; i++) {
    const t0 = new Date(recent[i].created_at).getTime();
    const t2 = new Date(recent[i + 2].created_at).getTime();
    if (t2 - t0 <= 60000) return true;
  }
  return false;
}

const router = Router();

// GET /welcome — landing page for unauthenticated users
router.get('/welcome', (req: Request, res: Response) => {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)jh_session=([^;]+)/);
  if (match) {
    const db = getDb();
    const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(match[1]) as SessionRow | undefined;
    if (session && new Date(session.expires_at) >= new Date()) {
      return res.redirect('/');
    }
  }
  const errorParam = String(req.query.error || '');
  const messageParam = String(req.query.message || '');
  const error = errorParam === 'email-confirm-expired'
    ? 'Confirmation link expired or already used. Please request a new email change.'
    : null;
  const message = messageParam === 'email-changed'
    ? 'Email address updated. Sign in with your new address.'
    : null;
  res.render('welcome', { error, message });
});

// POST /welcome/request — JSON OTP request (used by inline sign-in on /welcome)
router.post('/welcome/request', async (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body as Record<string, string>;
  const email = String(body.email || '').trim().toLowerCase();

  const profileCount = (db.prepare('SELECT COUNT(*) as c FROM profiles').get() as { c: number }).c;

  if (!email || !email.includes('@') || !email.includes('.')) {
    return res.json({ ok: false, error: 'Enter a valid email address.' });
  }

  // First-run: create admin account directly, no OTP needed
  if (profileCount === 0) {
    const result = db.prepare('INSERT INTO profiles (id, email, is_admin) VALUES (1, ?, 1)').run(email);
    const profileId = result.lastInsertRowid as number;
    db.prepare('UPDATE settings SET email_recipient = ? WHERE profile_id = ?').run(email, profileId);
    const token = createSession(db, profileId);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
    return res.json({ ok: true, redirect: '/' });
  }

  const profile = db.prepare('SELECT * FROM profiles WHERE email = ?').get(email) as ProfileRow | undefined;
  if (!profile) {
    return res.json({ ok: false, error: 'No account with this email.' });
  }

  if (isResendRateLimited(db, email)) {
    return res.json({ ok: false, error: 'Too many requests. Please wait 5 minutes.' });
  }

  const adminProfile = db.prepare('SELECT id FROM profiles WHERE is_admin = 1 LIMIT 1').get() as { id: number } | undefined;
  const adminSettings = adminProfile
    ? db.prepare('SELECT resend_api_key, email_from FROM settings WHERE profile_id = ?').get(adminProfile.id) as { resend_api_key: string; email_from: string } | undefined
    : undefined;

  if (!adminSettings?.resend_api_key) {
    return res.json({ ok: false, error: 'Email delivery not configured. Contact the administrator.' });
  }

  const otp = generateOtp();
  const now = new Date().toISOString();
  const otpExpiry = new Date(Date.now() + OTP_MINUTES * 60000).toISOString();

  db.prepare('UPDATE otp_codes SET used = 1 WHERE email = ? AND used = 0').run(email);
  db.prepare('INSERT INTO otp_codes (email, code, attempts, created_at, expires_at, used) VALUES (?, ?, 0, ?, ?, 0)').run(email, otp, now, otpExpiry);

  try {
    const resend = new Resend(adminSettings.resend_api_key);
    const from = adminSettings.email_from || 'noreply@example.com';
    const { error: sendErr } = await resend.emails.send({
      from,
      to: email,
      subject: `Your login code: ${otp}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 16px;">
          <h2 style="margin:0 0 16px;color:#111827;">Job Hunter — Login Code</h2>
          <p style="font-size:48px;font-weight:700;letter-spacing:12px;font-family:monospace;
                    color:#2563EB;margin:0 0 16px;">${otp}</p>
          <p style="color:#6B7280;font-size:14px;">Expires in ${OTP_MINUTES} minutes. Do not share this code.</p>
        </div>`,
    });
    if (sendErr) throw new Error(sendErr.message);
  } catch (err) {
    console.error('[auth] OTP send failed:', (err as Error).message);
    return res.json({ ok: false, error: 'Failed to send login code. Try again.' });
  }

  return res.json({ ok: true });
});

// POST /welcome/verify — JSON OTP verify (sets session cookie on success)
router.post('/welcome/verify', (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body as Record<string, string>;
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').replace(/\s/g, '');

  if (!email || !code) {
    return res.json({ ok: false, error: 'Enter the 6-digit code.' });
  }

  const now = new Date();
  const otpRow = db.prepare(
    'SELECT * FROM otp_codes WHERE email = ? AND used = 0 ORDER BY id DESC LIMIT 1'
  ).get(email) as OtpCodeRow | undefined;

  if (!otpRow) {
    return res.json({ ok: false, error: 'No active code. Request a new one.' });
  }

  if (new Date(otpRow.expires_at) < now) {
    db.prepare('UPDATE otp_codes SET used = 1 WHERE id = ?').run(otpRow.id);
    return res.json({ ok: false, error: 'Code expired. Request a new one.' });
  }

  const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
  const recentAttempts = (db.prepare(
    'SELECT COALESCE(SUM(attempts), 0) as total FROM otp_codes WHERE email = ? AND created_at > ?'
  ).get(email, fiveMinAgo) as { total: number }).total;

  if (recentAttempts >= 5) {
    return res.json({ ok: false, error: 'Too many incorrect attempts. Please wait 5 minutes.' });
  }

  if (otpRow.code !== code) {
    db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(otpRow.id);
    return res.json({ ok: false, error: 'Wrong code.' });
  }

  db.prepare('UPDATE otp_codes SET used = 1 WHERE id = ?').run(otpRow.id);
  const profile = db.prepare('SELECT * FROM profiles WHERE email = ?').get(email) as ProfileRow;
  const token = createSession(db, profile.id);

  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
  return res.json({ ok: true });
});

// GET /settings/confirm-email — apply a pending email change via token
router.get('/settings/confirm-email', (req: Request, res: Response) => {
  const token = String(req.query.token || '');
  if (!token) return res.redirect('/welcome');

  const db = getDb();
  const changeReq = db.prepare(
    'SELECT * FROM email_change_requests WHERE token = ? AND used = 0'
  ).get(token) as EmailChangeRequestRow | undefined;

  if (!changeReq || new Date(changeReq.expires_at) < new Date()) {
    return res.redirect('/welcome?error=email-confirm-expired');
  }

  // Guard: new email must not be taken by another profile
  const taken = db.prepare('SELECT id FROM profiles WHERE email = ? AND id != ?').get(changeReq.new_email, changeReq.profile_id);
  if (taken) {
    db.prepare('UPDATE email_change_requests SET used = 1 WHERE id = ?').run(changeReq.id);
    return res.redirect('/settings?tab=profile&error=email-taken-on-confirm');
  }

  // Apply email change
  db.prepare('UPDATE profiles SET email = ? WHERE id = ?').run(changeReq.new_email, changeReq.profile_id);
  db.prepare('UPDATE settings SET email_recipient = ? WHERE profile_id = ?').run(changeReq.new_email, changeReq.profile_id);
  db.prepare('UPDATE email_change_requests SET used = 1 WHERE id = ?').run(changeReq.id);

  // Check if the current browser has a valid session for this profile
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)jh_session=([^;]+)/);
  if (match) {
    const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(match[1]) as SessionRow | undefined;
    if (session && session.profile_id === changeReq.profile_id && new Date(session.expires_at) >= new Date()) {
      // Keep current session, invalidate all others
      db.prepare('DELETE FROM sessions WHERE profile_id = ? AND token != ?').run(changeReq.profile_id, match[1]);
      return res.redirect('/settings?tab=profile&message=email-changed');
    }
  }

  // No valid session — invalidate all sessions and send to login
  db.prepare('DELETE FROM sessions WHERE profile_id = ?').run(changeReq.profile_id);
  return res.redirect('/welcome?message=email-changed');
});

// POST /logout — destroy session
router.post('/logout', (req: Request, res: Response) => {
  const db = getDb();
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)jh_session=([^;]+)/);
  if (match) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(match[1]);
  }
  res.setHeader('Set-Cookie', 'jh_session=; Path=/; Max-Age=0; HttpOnly');
  res.redirect('/welcome');
});

export { router as authRouter };
