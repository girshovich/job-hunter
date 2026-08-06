import * as crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import { Resend } from 'resend';
import { getDb, createProfile, type ProfileRow, type OtpCodeRow, type SessionRow, type EmailChangeRequestRow } from '../db';

export const SESSION_COOKIE = 'jh_session';
export const SESSION_DAYS = 30;

const OTP_MINUTES = 15;

// Sign-up codes go to addresses that have asked for nothing yet, so they are the one part of login
// an outsider can trigger at will. The mail plan is billed monthly with no daily ceiling, which
// makes a burst the dangerous shape: unthrottled it would exhaust the month in hours and take the
// digests down with it for weeks. So the cap is sized by arithmetic rather than by the quota —
// even 30 days of continuous saturation (750 × 30 = 22 500) stays a minority of the monthly
// allowance, leaving the digests and every existing user's login untouched.
// Counts **sends, not people**: a resend re-posts to /welcome/request while the address is still
// unknown, so it burns a slot too.
const NEW_ACCOUNT_DAILY_CAP = 750;

// Shown when the cap refuses a send. Deliberately vague and never mentions accounts — see the
// enumeration note at the call site.
const GENERIC_SEND_FAILURE = "Couldn't send a code right now — please try again later.";

function generateOtp(): string {
  return String(crypto.randomInt(100000, 1000000));
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// The cookie carries the raw token; only its hash is stored, so a leaked DB yields no usable sessions.
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createSession(db: ReturnType<typeof getDb>, profileId: number): string {
  const token = generateToken();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare(
    'INSERT INTO sessions (token, profile_id, created_at, expires_at, last_active) VALUES (?, ?, ?, ?, ?)'
  ).run(hashToken(token), profileId, now, expiresAt, now);
  return token;
}

function seedAppUrlIfEmpty(db: ReturnType<typeof getDb>, profileId: number, isAdmin: boolean, req: Request): void {
  if (!isAdmin) return;
  const row = db.prepare('SELECT app_url FROM settings WHERE profile_id = ?').get(profileId) as { app_url?: string } | undefined;
  if (!row || row.app_url) return;
  db.prepare('UPDATE settings SET app_url = ? WHERE profile_id = ?').run(`${req.protocol}://${req.get('host')}`, profileId);
}

function verifyOtp(db: ReturnType<typeof getDb>, email: string, code: string): { ok: boolean; profileId?: number; error?: string } {
  const now = new Date();
  const otpRow = db.prepare(
    'SELECT * FROM otp_codes WHERE email = ? AND used = 0 ORDER BY id DESC LIMIT 1'
  ).get(email) as OtpCodeRow | undefined;

  if (!otpRow) return { ok: false, error: 'No active code. Request a new one.' };

  if (new Date(otpRow.expires_at) < now) {
    db.prepare('UPDATE otp_codes SET used = 1 WHERE id = ?').run(otpRow.id);
    return { ok: false, error: 'Code expired. Request a new one.' };
  }

  const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
  const recentAttempts = (db.prepare(
    'SELECT COALESCE(SUM(attempts), 0) as total FROM otp_codes WHERE email = ? AND created_at > ?'
  ).get(email, fiveMinAgo) as { total: number }).total;

  if (recentAttempts >= 5) {
    return { ok: false, error: 'Too many incorrect attempts. Please wait 5 minutes.' };
  }

  if (otpRow.code !== code) {
    db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(otpRow.id);
    return { ok: false, error: 'Wrong code.' };
  }

  db.prepare('UPDATE otp_codes SET used = 1 WHERE id = ?').run(otpRow.id);

  // A correct code proves the address receives mail, so a first-time sender gets their account here
  // rather than at request time — addresses that never verify never reach `profiles`. Both callers
  // land here, so the magic link completes a sign-up just as the typed code does. That also means a
  // mail scanner prefetching the link creates the account before the human clicks; such a profile
  // has no Role, no keys and no credits, so it does nothing but occupy a row.
  return { ok: true, profileId: findOrCreateProfile(db, email) };
}

// `profiles.email` is UNIQUE, so two verifications racing — the typed code and a prefetched magic
// link, say — cannot create two accounts: the loser's INSERT throws and we take the row that won.
function findOrCreateProfile(db: ReturnType<typeof getDb>, email: string): number {
  const existing = db.prepare('SELECT id FROM profiles WHERE email = ?').get(email) as { id: number } | undefined;
  if (existing) return existing.id;

  try {
    const { id } = createProfile(db, email);
    console.log(`[auth] Created profile ${id} for ${email} on first verified sign-in`);
    return id;
  } catch (err) {
    const raced = db.prepare('SELECT id FROM profiles WHERE email = ?').get(email) as { id: number } | undefined;
    if (raced) return raced.id;
    throw err;
  }
}

// Rolling 24h count of codes sent to addresses that had no profile at the time. Reads the flag
// stamped on the row rather than re-checking `profiles`, because sign-up creates the profile on
// verify — a retroactive join would stop counting a code the moment its owner got in, letting the
// cap drift upward by exactly the number of successful sign-ups.
function newAccountSendsToday(db: ReturnType<typeof getDb>): number {
  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  return (db.prepare(
    'SELECT COUNT(*) as c FROM otp_codes WHERE for_new_account = 1 AND created_at > ?'
  ).get(dayAgo) as { c: number }).c;
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
    const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(hashToken(match[1])) as SessionRow | undefined;
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
    seedAppUrlIfEmpty(db, profileId, true, req);
    const token = createSession(db, profileId);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
    return res.json({ ok: true, redirect: '/' });
  }

  // An unknown address is a sign-up, not an error: the code is sent either way and the profile is
  // created on verify (verifyOtp). Only the cap distinguishes the two cases, and it answers with
  // GENERIC_SEND_FAILURE so the wording never confirms whether an account exists. Note the residual:
  // while the cap is saturated an unknown address fails where a known one still succeeds, so the
  // success/failure split remains observable — narrowed to an abnormal window an attacker must burn
  // NEW_ACCOUNT_DAILY_CAP sends to open, not closed outright.
  const existing = db.prepare('SELECT id FROM profiles WHERE email = ?').get(email) as { id: number } | undefined;
  const isNewAccount = !existing;

  if (isNewAccount && newAccountSendsToday(db) >= NEW_ACCOUNT_DAILY_CAP) {
    console.warn(`[auth] New-account code cap reached (${NEW_ACCOUNT_DAILY_CAP}/24h) — refused sign-up send to ${email}`);
    return res.json({ ok: false, error: GENERIC_SEND_FAILURE });
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
  db.prepare('INSERT INTO otp_codes (email, code, attempts, created_at, expires_at, used, for_new_account) VALUES (?, ?, 0, ?, ?, 0, ?)').run(email, otp, now, otpExpiry, isNewAccount ? 1 : 0);

  const loginLink = `${req.protocol}://${req.get('host')}/welcome/verify?email=${encodeURIComponent(email)}&code=${otp}`;
  try {
    const resend = new Resend(adminSettings.resend_api_key);
    const from = adminSettings.email_from || 'noreply@example.com';
    const { error: sendErr } = await resend.emails.send({
      from,
      to: email,
      subject: `Job Search code: ${otp}`,
      html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Job Search</title></head>
<body style="font-family:'Plus Jakarta Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f3f4f7;margin:0;padding:0;">
  <div style="max-width:520px;margin:0 auto;padding:24px 16px;">
    <div style="background:#ffffff;border:1px solid #ebedf1;border-radius:16px;box-shadow:0 1px 2px rgba(16,24,40,0.05);padding:24px;">
      <h3 style="margin:0 0 14px;font-size:17px;font-weight:800;color:#131722;letter-spacing:-0.01em;">Log in to Job Search</h3>
      <p style="margin:0 0 14px;font-size:44px;font-weight:800;letter-spacing:10px;color:#4373ff;font-variant-numeric:tabular-nums;">${otp}</p>
      <p style="color:#5b6472;font-size:13.5px;line-height:1.6;margin:0;">Expires in ${OTP_MINUTES} minutes. Do not share this code.</p>
      <p style="color:#5b6472;font-size:13.5px;line-height:1.6;margin:14px 0 0;">
        Or <a href="${loginLink}" style="color:#4373ff;text-decoration:none;font-weight:600;">click here to log in</a> in a new tab — no code needed.
      </p>
    </div>
    <p style="text-align:center;color:#8a91a0;font-size:12px;margin-top:24px;">Sent by Job Search</p>
  </div>
</body>
</html>`,
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

  const result = verifyOtp(db, email, code);
  if (!result.ok || !result.profileId) {
    return res.json({ ok: false, error: result.error });
  }

  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(result.profileId) as ProfileRow;
  seedAppUrlIfEmpty(db, profile.id, !!profile.is_admin, req);
  const token = createSession(db, profile.id);

  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
  return res.json({ ok: true });
});

// GET /welcome/verify — magic-link login from OTP email
router.get('/welcome/verify', (req: Request, res: Response) => {
  const db = getDb();
  const email = String(req.query.email || '').trim().toLowerCase();
  const code = String(req.query.code || '').replace(/\s/g, '');

  if (!email || !code) {
    return res.redirect('/welcome?error=invalid-link');
  }

  const result = verifyOtp(db, email, code);
  if (!result.ok || !result.profileId) {
    return res.redirect(`/welcome?error=${encodeURIComponent(result.error || 'Invalid code')}`);
  }

  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(result.profileId) as ProfileRow;
  seedAppUrlIfEmpty(db, profile.id, !!profile.is_admin, req);
  const token = createSession(db, result.profileId);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
  return res.redirect('/');
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
    const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(hashToken(match[1])) as SessionRow | undefined;
    if (session && session.profile_id === changeReq.profile_id && new Date(session.expires_at) >= new Date()) {
      // Keep current session, invalidate all others
      db.prepare('DELETE FROM sessions WHERE profile_id = ? AND token != ?').run(changeReq.profile_id, hashToken(match[1]));
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
    db.prepare('DELETE FROM sessions WHERE token = ?').run(hashToken(match[1]));
  }
  res.setHeader('Set-Cookie', 'jh_session=; Path=/; Max-Age=0; HttpOnly');
  res.redirect('/welcome');
});

export { router as authRouter };
