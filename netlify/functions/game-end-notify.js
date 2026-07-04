// Scheduled (hourly): emails Erik when a dice-game competition ends — once per game.
//
// It reads the current competition from `settings`, decides whether it has ended
// (today in Central time is past the end date, OR it was force-ended), and — if it
// hasn't already emailed for that game — sends the winner + standings, then records a
// `game_notified_period` marker so it never double-sends.
//
// Sending uses the site's own Private Email mailbox over SMTP (nodemailer).
// REQUIRED env: PRIVATE_EMAIL_PASS — the deals@founditcheaper.net mailbox password.
// OPTIONAL env: GAME_ALERT_TO (recipient; default = business Gmail),
//               PRIVATE_EMAIL_USER (sender; default = deals@founditcheaper.net).

const nodemailer = require('nodemailer');
const crypto = require('crypto');

const SMTP_HOST = 'mail.privateemail.com';
const SMTP_PORT = 465;                                     // SSL
const FROM = process.env.PRIVATE_EMAIL_USER || 'deals@founditcheaper.net';
const TO   = process.env.GAME_ALERT_TO || 'mm.founditcheaper@gmail.com';

function todayCT() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

exports.handler = async function () {
  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) { console.error('[game-end-notify] missing supabase env'); return { statusCode: 500, body: 'config error' }; }
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  // 1) Current competition + "already notified" marker.
  const settings = {};
  try {
    const r = await fetch(`${sbUrl}/rest/v1/settings?select=key,value`, { headers: H });
    const rows = await r.json();
    if (Array.isArray(rows)) rows.forEach(function (x) { settings[x.key] = x.value; });
  } catch (e) { console.error('[game-end-notify] settings read failed:', e.message); return { statusCode: 200, body: 'settings read failed' }; }

  const start = settings.game_period_start || '';
  const end   = settings.game_period_end || '';
  const forceEnded = String(settings.game_ended || '0') === '1';

  if (!start || !end) return { statusCode: 200, body: JSON.stringify({ ok: true, skip: 'no game configured' }) };

  // 2) Has it ended? (past the end date in Central time, or force-ended)
  const ended = forceEnded || todayCT() > end;
  if (!ended) return { statusCode: 200, body: JSON.stringify({ ok: true, skip: 'game still live' }) };

  // 3) Send once per game.
  if ((settings.game_notified_period || '') === start) return { statusCode: 200, body: JSON.stringify({ ok: true, skip: 'already notified' }) };

  // 4) Need the mailbox password to send. Bail WITHOUT marking so it retries once set.
  if (!process.env.PRIVATE_EMAIL_PASS) {
    console.warn('[game-end-notify] PRIVATE_EMAIL_PASS not set — cannot send yet');
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'PRIVATE_EMAIL_PASS not set' }) };
  }

  // 5) Standings for this game.
  let players = [];
  try {
    const r = await fetch(`${sbUrl}/rest/v1/game_scores?week_start=eq.${encodeURIComponent(start)}&select=id,username,player_tag,email,week_score,claim_token,claimed_at&order=week_score.desc&limit=25`, { headers: H });
    const rows = await r.json();
    if (Array.isArray(rows)) players = rows;
  } catch (e) { console.error('[game-end-notify] scores read failed:', e.message); }

  const range = start === end ? start : (start + ' to ' + end);
  const prize = settings.game_prize || '';
  const winner = players[0];
  const winnerEmail = (winner && String(winner.email || '').trim()) || '';

  // Give the winner a one-time claim token so their "Yes, send me my gift card" button
  // works. Store it on their row (reuse one if it's somehow already set).
  let claimToken = (winner && winner.claim_token) || '';
  if (winner && winnerEmail && !claimToken) {
    claimToken = crypto.randomBytes(16).toString('hex');
    await fetch(`${sbUrl}/rest/v1/game_scores?id=eq.${encodeURIComponent(winner.id)}`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ claim_token: claimToken }),
    }).catch(function () { claimToken = ''; });
  }

  const subject = winner
    ? `Dice game ended (${range}) — winner: ${winner.username} (${winner.week_score} pts)`
    : `Dice game ended (${range}) — no players`;

  let html = `<h2 style="margin:0 0 8px">Dice game ended</h2><p style="margin:0 0 12px"><strong>Competition:</strong> ${esc(range)}${prize ? ` &middot; <strong>Prize:</strong> ${esc(prize)}` : ''}</p>`;
  if (winner) {
    html += `<p style="font-size:15px;margin:0 0 12px">🏆 <strong>Winner: ${esc(winner.username)}</strong> <span style="color:#888">#${esc(winner.player_tag || '?')}</span> — <strong>${winner.week_score} pts</strong><br><span style="color:#555">${esc(winner.email || '(no email on file)')}</span></p>`;
    html += winnerEmail
      ? `<p style="font-size:13px;color:#0a7d2c;margin:0 0 12px">We emailed the winner a "Yes, send me my gift card" button. You'll get a second email the moment they click it — that confirms a real person is on the other end before you send the gift card.</p>`
      : `<p style="font-size:13px;color:#b00;margin:0 0 12px">This winner has no email on file, so we could not send them a claim link. Reach out via their standings info.</p>`;
    html += `<p style="margin:0 0 4px"><strong>Top players:</strong></p><ol style="margin:0 0 12px;padding-left:20px">`;
    players.slice(0, 10).forEach(function (p) { html += `<li>${esc(p.username)} <span style="color:#888">#${esc(p.player_tag || '?')}</span> — ${p.week_score} pts — <span style="color:#555">${esc(p.email || '')}</span></li>`; });
    html += `</ol>`;
  } else {
    html += `<p>No one played this round.</p>`;
  }
  html += `<p style="color:#888;font-size:12px">Full standings + emails are in the admin panel → Dice Game.</p>`;

  // 6) Send — first to Erik (required), then to the winner (best-effort).
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: true,
    auth: { user: FROM, pass: process.env.PRIVATE_EMAIL_PASS },
  });
  try {
    await transporter.sendMail({ from: `founditcheaper <${FROM}>`, to: TO, subject: subject, html: html });
  } catch (e) {
    console.error('[game-end-notify] owner email send failed:', e.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'send failed: ' + String(e.message).slice(0, 160) }) };
  }

  // Tell the winner they won and give them the confirm button.
  if (winnerEmail && claimToken) {
    try {
      const claimUrl = 'https://founditcheaper.net/claim-prize/' + claimToken;
      const wHtml =
        '<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:520px">' +
          '<h2 style="margin:0 0 10px">You won the founditcheaper dice game</h2>' +
          '<p style="font-size:15px;margin:0 0 6px">You had the top score this round' + (prize ? ', so you won <strong>' + esc(prize) + '</strong>' : '') + '.</p>' +
          '<p style="font-size:14px;color:#333;margin:0 0 14px">To get it, confirm you are a real person by clicking below.</p>' +
          '<p style="margin:0 0 16px"><a href="' + claimUrl + '" style="background:#f5c842;color:#0a1a2f;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:6px;display:inline-block">Yes, send me my gift card</a></p>' +
          '<p style="font-size:13px;color:#555;margin:0 0 4px">Why the extra step: emails sometimes go unseen, and sometimes they are fake. This click tells us a real person is on the other end, so we can send your gift card safely.</p>' +
          '<p style="font-size:12px;color:#999;margin:12px 0 0">If this was not you, you can ignore this email.</p>' +
        '</div>';
      await transporter.sendMail({
        from: `founditcheaper <${FROM}>`, to: winnerEmail,
        subject: 'You won the founditcheaper dice game',
        html: wHtml,
      });
    } catch (e) { console.error('[game-end-notify] winner email failed:', e.message); }
  }

  // 7) Mark notified so it never double-sends.
  try {
    await fetch(`${sbUrl}/rest/v1/settings`, {
      method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: 'game_notified_period', value: start }),
    });
  } catch (e) { console.error('[game-end-notify] marker write failed:', e.message); }

  console.log(`[game-end-notify] emailed winner for ${range}`);
  return { statusCode: 200, body: JSON.stringify({ ok: true, notified: start, winner: winner ? winner.username : null }) };
};
