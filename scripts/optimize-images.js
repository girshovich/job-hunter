#!/usr/bin/env node
/**
 * Re-encodes the static images under src/public as WebP.
 *
 * Not part of `npm run build` on purpose: the .webp files are committed, and
 * re-encoding an already-encoded image on every build would compound the loss.
 * Run it by hand (`npm run images`) after adding or replacing a source image.
 *
 * Sources live outside the repo (../../YAJS post) for the product screenshots;
 * what is checked in here is already the sized-down intermediate, so a re-run
 * is idempotent in size but does cost one more generation of quality. Prefer
 * re-cutting from the original PNG when a screenshot changes.
 */
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'src', 'public');

// UI screenshots are text-heavy: q82 keeps labels legible and still halves the file.
// Flat artwork (the logo, the company mark) is tried lossless too — on large areas
// of solid colour that often wins, so we keep whichever comes out smaller.
const JOBS = [
  { file: 'logo.PNG', quality: 90, tryLossless: true },
  { file: 'misha.jpg', quality: 80 },
  { file: 'screens/matches.jpg', quality: 82 },
  { file: 'screens/roles.jpg', quality: 82 },
  { file: 'screens/stats.jpg', quality: 82 },
  { file: 'screens/mail.jpg', quality: 82 },
  { file: 'screens/profile.jpg', quality: 82 },
  { file: 'screens/aisetup.jpg', quality: 82 },
  { file: 'screens/schedule.jpg', quality: 84 },
  { file: 'screens/company.png', quality: 90, tryLossless: true },
];

const kb = (n) => `${Math.round(n / 1024)}KB`;

(async () => {
  let before = 0;
  let after = 0;

  for (const { file, quality, tryLossless } of JOBS) {
    const src = path.join(PUBLIC, file);
    if (!fs.existsSync(src)) {
      console.log(`  skip   ${file} (missing)`);
      continue;
    }
    const out = src.replace(/\.(png|jpe?g)$/i, '.webp');
    const input = fs.readFileSync(src);

    let buf = await sharp(input).webp({ quality, effort: 6 }).toBuffer();
    let mode = `q${quality}`;
    if (tryLossless) {
      const lossless = await sharp(input).webp({ lossless: true, effort: 6 }).toBuffer();
      if (lossless.length < buf.length) {
        buf = lossless;
        mode = 'lossless';
      }
    }

    fs.writeFileSync(out, buf);
    before += input.length;
    after += buf.length;
    const pct = Math.round((1 - buf.length / input.length) * 100);
    console.log(
      `  ${path.basename(out).padEnd(16)} ${kb(input.length).padStart(6)} → ${kb(buf.length).padStart(6)}  (-${pct}%, ${mode})`,
    );
  }

  console.log(`\n  total ${kb(before)} → ${kb(after)}  (-${Math.round((1 - after / before) * 100)}%)`);
})();
