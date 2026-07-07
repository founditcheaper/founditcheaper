// Scheduled: when a dice game is live, email everyone on the game_notify list once,
// so people who asked to be told when the next game starts get a nudge to come play.
//
// Dedup is PER SUBSCRIBER (game_notify.last_notified_period). We only email active
// subscribers whose last_notified_period != the current game's start, then stamp it.
// So a timeout mid-send never double-emails anyone: the next run just picks up whoever
// wasn't stamped yet. Each email has an obvious one-tap opt-out.
//
// REQUIRED env: PRIVATE_EMAIL_PASS. OPTIONAL: PRIVATE_EMAIL_USER.

const nodemailer = require('nodemailer');

const SMTP_HOST = 'mail.privateemail.com';
const SMTP_PORT = 465;                                     // SSL
const FROM = process.env.PRIVATE_EMAIL_USER || 'deals@founditcheaper.net';
const PLAY_URL = 'https://founditcheaper.net/founditcheaper-game.html';
const MAX_PER_RUN = 400;                                   // stay well inside the function timeout

function todayCT() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

exports.handler = async function () {
  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) { console.error('[game-live-notify] missing supabase env'); return { statusCode: 500, body: 'config error' }; }
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  // 1) Current competition.
  const settings = {};
  try {
    const r = await fetch(`${sbUrl}/rest/v1/settings?select=key,value`, { headers: H });
    const rows = await r.json();
    if (Array.isArray(rows)) rows.forEach(function (x) { settings[x.key] = x.value; });
  } catch (e) { console.error('[game-live-notify] settings read failed:', e.message); return { statusCode: 200, body: 'settings read failed' }; }

  const start = settings.game_period_start || '';
  const end   = settings.game_period_end || '';
  const forceEnded = String(settings.game_ended || '0') === '1';
  if (!start || !end) return { statusCode: 200, body: JSON.stringify({ ok: true, skip: 'no game configured' }) };

  // 2) Is a game live right now (in Central time, not force-ended)?
  const t = todayCT();
  const live = !forceEnded && t >= start && t <= end;
  if (!live) return { statusCode: 200, body: JSON.stringify({ ok: true, skip: 'no live game' }) };

  // 3) Need the mailbox password to send.
  if (!process.env.PRIVATE_EMAIL_PASS) {
    console.warn('[game-live-notify] PRIVATE_EMAIL_PASS not set — cannot send yet');
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'PRIVATE_EMAIL_PASS not set' }) };
  }

  // 4) Active subscribers not yet notified for THIS game.
  let subs = [];
  try {
    const r = await fetch(
      `${sbUrl}/rest/v1/game_notify?active=eq.true&or=(last_notified_period.is.null,last_notified_period.neq.${encodeURIComponent(start)})&select=id,email,token&limit=${MAX_PER_RUN}`,
      { headers: H }
    );
    const rows = await r.json();
    if (Array.isArray(rows)) subs = rows;
  } catch (e) { console.error('[game-live-notify] subscribers read failed:', e.message); return { statusCode: 200, body: 'subs read failed' }; }

  if (!subs.length) return { statusCode: 200, body: JSON.stringify({ ok: true, skip: 'nobody to notify' }) };

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: true,
    auth: { user: FROM, pass: process.env.PRIVATE_EMAIL_PASS },
  });

  let sent = 0;
  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    const email = String(s.email || '').trim();
    if (!email.includes('@')) continue;
    const stopUrl = 'https://founditcheaper.net/stop-game-notify/' + encodeURIComponent(s.token || '');
    // Deadpan + deliverability-safe (no gift card / prize / won / free / $ amounts).
    const html =
      '<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:520px;font-size:15px;line-height:1.55">' +
        '<p style="margin:0 0 12px">The founditcheaper dice game is live again. You asked us to let you know when a new round starts, so here it is.</p>' +
        '<p style="margin:0 0 14px">Roll every day. Highest score by the end of the round comes out on top.</p>' +
        '<p style="margin:0 0 16px"><a href="' + PLAY_URL + '" style="background:#f5c842;color:#0a1a2f;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:6px;display:inline-block">Play the dice game</a></p>' +
        '<p style="font-size:12px;color:#888;margin:16px 0 0">Do not want these? <a href="' + stopUrl + '" style="color:#888">Turn off game alerts</a>.</p>' +
      '</div>';
    const text = 'The founditcheaper dice game is live again. Roll every day. Play here: ' + PLAY_URL
      + '. Turn off game alerts: ' + stopUrl;
    try {
      await transporter.sendMail({
        from: `founditcheaper <${FROM}>`, to: email,
        subject: 'The founditcheaper dice game just started',
        html, text,
      });
      // Stamp this subscriber so a retry never re-sends to them.
      await fetch(`${sbUrl}/rest/v1/game_notify?id=eq.${encodeURIComponent(s.id)}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ last_notified_period: start }),
      }).catch(function () {});
      sent++;
    } catch (e) { console.error('[game-live-notify] send failed for one subscriber:', e.message); }
  }

  console.log(`[game-live-notify] emailed ${sent} subscriber(s) for game ${start}`);
  return { statusCode: 200, body: JSON.stringify({ ok: true, sent, period: start }) };
};
