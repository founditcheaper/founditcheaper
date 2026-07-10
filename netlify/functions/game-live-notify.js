// Scheduled: when a game goes live, email everyone on the game_notify list once, so
// people who asked to be told when the next game starts get a nudge to come play.
//
// Covers BOTH games (Flappy Banana and the dice game). One list, one opt-out: people
// signed up to hear "when the next game is live", and either game qualifies. The email
// says which one it is.
//
// Dedup is PER SUBSCRIBER, PER GAME (last_flappy_period / last_notified_period hold the
// period start we last emailed that person about for that game). We only email active
// subscribers whose marker != the current period, then stamp it. So a timeout mid-send
// never double-emails anyone: the next run picks up whoever wasn't stamped yet, and a
// second game going live can't un-stamp the first.
//
// REQUIRED env: PRIVATE_EMAIL_PASS. OPTIONAL: PRIVATE_EMAIL_USER.

const nodemailer = require('nodemailer');

const SMTP_HOST = 'mail.privateemail.com';
const SMTP_PORT = 465;                                     // SSL
const FROM = process.env.PRIVATE_EMAIL_USER || 'deals@founditcheaper.net';
const MAX_PER_RUN = 400;                                   // stay well inside the function timeout

function todayCT() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }

// Everything that differs between the two games lives here.
const GAMES = [
  {
    key: 'flappy',
    markerCol: 'last_flappy_period',
    startKey: 'flappy_period_start', endKey: 'flappy_period_end', endedKey: 'flappy_ended',
    url: 'https://founditcheaper.net/founditcheaper-flappy.html',
    subject: 'Flappy Banana just started',
    lead: 'Flappy Banana is live again. You asked us to let you know when a new round starts, so here it is.',
    rule: 'Tap to keep the banana in the air. Highest score by the end of the round comes out on top.',
    cta: 'Play Flappy Banana',
  },
  {
    key: 'dice',
    markerCol: 'last_notified_period',
    startKey: 'game_period_start', endKey: 'game_period_end', endedKey: 'game_ended',
    url: 'https://founditcheaper.net/founditcheaper-game.html',
    subject: 'The founditcheaper dice game just started',
    lead: 'The founditcheaper dice game is live again. You asked us to let you know when a new round starts, so here it is.',
    rule: 'Roll every day. Highest score by the end of the round comes out on top.',
    cta: 'Play the dice game',
  },
];

exports.handler = async function () {
  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) { console.error('[game-live-notify] missing supabase env'); return { statusCode: 500, body: 'config error' }; }
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  const settings = {};
  try {
    const r = await fetch(`${sbUrl}/rest/v1/settings?select=key,value`, { headers: H });
    const rows = await r.json();
    if (Array.isArray(rows)) rows.forEach(function (x) { settings[x.key] = x.value; });
  } catch (e) { console.error('[game-live-notify] settings read failed:', e.message); return { statusCode: 200, body: 'settings read failed' }; }

  const today = todayCT();
  const liveGames = GAMES.filter(function (g) {
    const start = settings[g.startKey] || '', end = settings[g.endKey] || '';
    const ended = String(settings[g.endedKey] || '0') === '1';
    return !!start && !!end && !ended && today >= start && today <= end;
  });
  if (!liveGames.length) return { statusCode: 200, body: JSON.stringify({ ok: true, skip: 'no live game' }) };

  if (!process.env.PRIVATE_EMAIL_PASS) {
    console.warn('[game-live-notify] PRIVATE_EMAIL_PASS not set — cannot send yet');
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'PRIVATE_EMAIL_PASS not set' }) };
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: true,
    auth: { user: FROM, pass: process.env.PRIVATE_EMAIL_PASS },
  });

  const sentPerGame = {};
  for (const g of liveGames) {
    const period = settings[g.startKey];

    // Active subscribers not yet notified about THIS game's current round.
    let subs = [];
    try {
      const r = await fetch(
        `${sbUrl}/rest/v1/game_notify?active=eq.true&or=(${g.markerCol}.is.null,${g.markerCol}.neq.${encodeURIComponent(period)})&select=id,email,token&limit=${MAX_PER_RUN}`,
        { headers: H }
      );
      const rows = await r.json();
      if (Array.isArray(rows)) subs = rows;
    } catch (e) { console.error('[game-live-notify] subscribers read failed:', e.message); continue; }

    let sent = 0;
    for (const s of subs) {
      const email = String(s.email || '').trim();
      if (!email.includes('@')) continue;
      const stopUrl = 'https://founditcheaper.net/stop-game-notify/' + encodeURIComponent(s.token || '');
      // Deadpan + deliverability-safe (no gift card / prize / won / free / $ amounts).
      const html =
        '<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:520px;font-size:15px;line-height:1.55">' +
          '<p style="margin:0 0 12px">' + g.lead + '</p>' +
          '<p style="margin:0 0 14px">' + g.rule + '</p>' +
          '<p style="margin:0 0 16px"><a href="' + g.url + '" style="background:#f5c842;color:#0a1a2f;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:6px;display:inline-block">' + g.cta + '</a></p>' +
          '<p style="font-size:12px;color:#888;margin:16px 0 0">Do not want these? <a href="' + stopUrl + '" style="color:#888">Turn off game alerts</a>.</p>' +
        '</div>';
      const text = g.lead + ' ' + g.rule + ' Play here: ' + g.url + '. Turn off game alerts: ' + stopUrl;
      try {
        await transporter.sendMail({ from: `founditcheaper <${FROM}>`, to: email, subject: g.subject, html, text });
        const patch = {}; patch[g.markerCol] = period;
        await fetch(`${sbUrl}/rest/v1/game_notify?id=eq.${encodeURIComponent(s.id)}`, {
          method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
          body: JSON.stringify(patch),
        }).catch(function () {});
        sent++;
      } catch (e) { console.error(`[game-live-notify] send failed (${g.key}):`, e.message); }
    }
    sentPerGame[g.key] = sent;
    if (sent) console.log(`[game-live-notify] emailed ${sent} subscriber(s) for ${g.key} ${period}`);
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, sent: sentPerGame }) };
};
