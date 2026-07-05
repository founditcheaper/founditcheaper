// Scheduled (every 15 min): emails dice-game players when their hourly roll cooldown is
// up, IF they opted in (roll_reminders.active). ONE reminder per eligibility window,
// deduped on the player's last_roll timestamp. So:
//   - an ACTIVE player (keeps rolling) gets ~hourly nudges (the whole point),
//   - a player who IGNORES a reminder and stops rolling gets that one email, then silence.
// The 1-hour cooldown is the natural per-user rate cap (max one reminder/hour/player).
// Only runs while a game is live. Sends via Private Email SMTP (needs PRIVATE_EMAIL_PASS).

const nodemailer = require('nodemailer');
const SMTP_HOST = 'mail.privateemail.com', SMTP_PORT = 465;
const FROM = process.env.PRIVATE_EMAIL_USER || 'deals@founditcheaper.net';
const SITE = 'https://founditcheaper.net';
const COOLDOWN_MS = 3600000;   // 1 hour, matches the game
const MAX_PER_RUN = 300;       // system-wide safety cap per run

function todayCT() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }

exports.handler = async function () {
  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, body: 'config error' };
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  // Only remind while a game is actually live.
  const settings = {};
  try { const r = await fetch(`${sbUrl}/rest/v1/settings?select=key,value`, { headers: H }); const rows = await r.json(); if (Array.isArray(rows)) rows.forEach(x => settings[x.key] = x.value); }
  catch (e) { return { statusCode: 200, body: 'settings read failed' }; }
  const start = settings.game_period_start || '', end = settings.game_period_end || '';
  const today = todayCT();
  const live = start && end && String(settings.game_ended || '0') !== '1' && today >= start && today <= end;
  if (!live) return { statusCode: 200, body: JSON.stringify({ ok: true, skip: 'no live game' }) };

  if (!process.env.PRIVATE_EMAIL_PASS) return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'PRIVATE_EMAIL_PASS not set' }) };

  // Opted-in players.
  let reminders = [];
  try { const r = await fetch(`${sbUrl}/rest/v1/roll_reminders?active=eq.true&select=email,token,last_reminded_roll`, { headers: H }); reminders = await r.json(); }
  catch (e) { return { statusCode: 200, body: 'reminders read failed' }; }
  if (!Array.isArray(reminders) || !reminders.length) return { statusCode: 200, body: JSON.stringify({ ok: true, sent: 0 }) };

  // This period's last_roll per email.
  const lastRollByEmail = {};
  try {
    const r = await fetch(`${sbUrl}/rest/v1/game_scores?week_start=eq.${encodeURIComponent(start)}&select=email,last_roll`, { headers: H });
    const rows = await r.json();
    if (Array.isArray(rows)) rows.forEach(x => { if (x.email) lastRollByEmail[String(x.email).toLowerCase()] = x.last_roll; });
  } catch (e) { return { statusCode: 200, body: 'scores read failed' }; }

  const now = Date.now();
  let transporter = null, sent = 0;

  for (const rem of reminders) {
    if (sent >= MAX_PER_RUN) break;
    const email = String(rem.email || '').toLowerCase();
    const lastRoll = lastRollByEmail[email];
    if (!lastRoll) continue;                                            // hasn't rolled this game -> nothing to remind about
    const lastMs = Date.parse(lastRoll);
    if (isNaN(lastMs)) continue;
    if (now < lastMs + COOLDOWN_MS) continue;                           // still on cooldown
    if (rem.last_reminded_roll && Date.parse(rem.last_reminded_roll) === lastMs) continue;  // already reminded for this roll

    const optOut = `${SITE}/.netlify/functions/stop-roll-reminder?token=${encodeURIComponent(rem.token || '')}`;
    const play = `${SITE}/founditcheaper-game.html`;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto">
      <p style="font-size:16px;color:#111">Your timer is up. You can roll again.</p>
      <p><a href="${play}" style="display:inline-block;background:#f5c842;color:#0a1f33;font-weight:bold;text-decoration:none;padding:12px 22px;border-radius:8px">Roll now</a></p>
      <p style="color:#777;font-size:12px;line-height:1.6;margin:16px 0 8px">This reminder goes out every time you can roll again. You stay in the game and on every other email.</p>
      <p style="margin:0"><a href="${optOut}" style="display:inline-block;background:#eef1f4;color:#333;font-weight:700;font-size:13px;text-decoration:none;padding:9px 16px;border-radius:6px;border:1px solid #d7dde3">Turn off these roll reminders</a></p>
    </div>`;

    try {
      if (!transporter) transporter = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: true, auth: { user: FROM, pass: process.env.PRIVATE_EMAIL_PASS } });
      await transporter.sendMail({ from: `founditcheaper <${FROM}>`, to: email, subject: 'Your dice roll is ready', html });
    } catch (e) { console.error('[roll-reminder] send failed for', email, e.message); continue; }

    // Dedupe marker: remember which roll we just reminded for.
    try {
      await fetch(`${sbUrl}/rest/v1/roll_reminders?email=eq.${encodeURIComponent(email)}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ last_reminded_roll: new Date(lastMs).toISOString() }),
      });
    } catch (e) { console.error('[roll-reminder] mark failed for', email, e.message); }
    sent++;
  }

  console.log(`[roll-reminder] sent ${sent}`);
  return { statusCode: 200, body: JSON.stringify({ ok: true, sent }) };
};
