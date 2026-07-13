// Scheduled (hourly): when a Flappy Banana competition ends, email the winner a
// "confirm it's you" button AND email Erik the standings — once per game.
//
// It reads the current competition from `settings` (flappy_* keys), decides whether
// it has ended (today in Central time is past the end date, OR it was force-ended),
// and — if it hasn't already emailed for that game — sends, then records a
// `flappy_notified_period` marker so it never double-sends.
//
// ROBUSTNESS (added 2026-07-11 after a live round marked itself "done" but the winner
// never got a working confirm email). The round is marked "done" ONLY after everything
// that should have happened, happened. Any failure returns WITHOUT marking, so the next
// hourly run retries:
//   * standings read must actually succeed (a transient failure used to be treated as
//     "no players", which emailed the wrong summary and then gave up)
//   * the winner's claim token must be CONFIRMED saved before we email them (otherwise
//     their "Confirm it is me" link points at a token that isn't in the database)
//   * the winner's email (if they have one) must actually send
//   * Erik's summary email must actually send
// The claim token is generated once and reused on retry, so retries are idempotent.
//
// Deliverability: the winner email avoids the words spam filters hate (gift card,
// prize, won, free, $ amounts). The real reward is revealed on the confirmation page.
//
// REQUIRED env: PRIVATE_EMAIL_PASS (the deals@founditcheaper.net mailbox password).
// OPTIONAL env: GAME_ALERT_TO (recipient), PRIVATE_EMAIL_USER (sender).

const nodemailer = require('nodemailer');
const crypto = require('crypto');

const SMTP_HOST = 'mail.privateemail.com';
const SMTP_PORT = 465;                                     // SSL
const FROM = process.env.PRIVATE_EMAIL_USER || 'deals@founditcheaper.net';
const TO   = process.env.GAME_ALERT_TO || 'deals@founditcheaper.net';

function todayCT() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

exports.handler = async function () {
  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) { console.error('[flappy-end-notify] missing supabase env'); return { statusCode: 500, body: 'config error' }; }
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  // 1) Current competition + "already notified" marker.
  const settings = {};
  try {
    const r = await fetch(`${sbUrl}/rest/v1/settings?select=key,value`, { headers: H });
    const rows = await r.json();
    if (Array.isArray(rows)) rows.forEach(function (x) { settings[x.key] = x.value; });
  } catch (e) { console.error('[flappy-end-notify] settings read failed:', e.message); return { statusCode: 200, body: 'settings read failed' }; }

  const start = settings.flappy_period_start || '';
  const end   = settings.flappy_period_end || '';
  const forceEnded = String(settings.flappy_ended || '0') === '1';

  if (!start || !end) return { statusCode: 200, body: JSON.stringify({ ok: true, skip: 'no game configured' }) };

  // 2) Has it ended?
  const ended = forceEnded || todayCT() > end;
  if (!ended) return { statusCode: 200, body: JSON.stringify({ ok: true, skip: 'game still live' }) };

  // 3) Send once per game.
  if ((settings.flappy_notified_period || '') === start) return { statusCode: 200, body: JSON.stringify({ ok: true, skip: 'already notified' }) };

  // 4) Need the mailbox password. Bail WITHOUT marking so it retries once set.
  if (!process.env.PRIVATE_EMAIL_PASS) {
    console.warn('[flappy-end-notify] PRIVATE_EMAIL_PASS not set — cannot send yet');
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'PRIVATE_EMAIL_PASS not set' }) };
  }

  // 5) Standings for this game. A successful read is REQUIRED — if it fails we return
  // without marking, so the next hourly run retries instead of wrongly reporting "no
  // players" and giving up.
  let players;
  try {
    const r = await fetch(`${sbUrl}/rest/v1/flappy_scores?period_start=eq.${encodeURIComponent(start)}&select=id,username,player_tag,email,best_score,claim_token,claimed_at&order=best_score.desc&limit=25`, { headers: H });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error('unexpected shape');
    players = rows;
  } catch (e) {
    console.error('[flappy-end-notify] standings read failed, will retry:', e.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'standings read failed, will retry' }) };
  }

  const range = start === end ? start : (start + ' to ' + end);
  const prize = settings.flappy_prize || '';
  const winner = players[0];
  const winnerEmail = (winner && String(winner.email || '').trim()) || '';

  // 6) If there is a winner WITH an email, make sure their claim token is CONFIRMED saved
  // before we email them. If the save fails, bail without marking so we retry (rather than
  // emailing a "Confirm it is me" link whose token isn't in the database).
  let claimToken = (winner && winner.claim_token) || '';
  if (winner && winnerEmail && !claimToken) {
    claimToken = crypto.randomBytes(16).toString('hex');
    let saved = false;
    try {
      const pr = await fetch(`${sbUrl}/rest/v1/flappy_scores?id=eq.${encodeURIComponent(winner.id)}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ claim_token: claimToken }),
      });
      saved = pr.ok;
    } catch (e) { console.error('[flappy-end-notify] token save threw:', e.message); }
    if (!saved) {
      console.error('[flappy-end-notify] claim token save failed, will retry');
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'token save failed, will retry' }) };
    }
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: true,
    auth: { user: FROM, pass: process.env.PRIVATE_EMAIL_PASS },
  });

  // 7) Email the winner their confirm button FIRST — this is the part that was silently
  // failing. If a winner with an email doesn't get it, bail without marking so we retry.
  if (winner && winnerEmail && claimToken) {
    try {
      const claimUrl = 'https://founditcheaper.net/claim-flappy/' + claimToken;
      const wHtml =
        '<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:520px;font-size:15px;line-height:1.55">' +
          '<p style="margin:0 0 12px">Hey, you had the top score in the founditcheaper banana game this round.</p>' +
          '<p style="margin:0 0 14px">Before we sort out the details, confirm it is really you:</p>' +
          '<p style="margin:0 0 16px"><a href="' + claimUrl + '" style="background:#f5c842;color:#0a1a2f;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:6px;display:inline-block">Confirm it is me</a></p>' +
          '<p style="margin:0 0 14px;color:#333">Or just reply to this email with a yes, and we will take it from there.</p>' +
          '<p style="font-size:13px;color:#555;margin:0 0 4px">Why the step: emails get missed sometimes, and not every address is a real person. This is how we know someone real is on the other end before we send anything out.</p>' +
          '<p style="font-size:12px;color:#999;margin:12px 0 0">If this was not you, you can ignore this email.</p>' +
        '</div>';
      const wText = 'You had the top score in the founditcheaper banana game this round. '
        + 'Confirm it is really you here: ' + claimUrl + '. Or reply to this email with a yes. '
        + 'We ask because emails get missed and not every address is a real person, so this tells us '
        + 'someone real is on the other end. If this was not you, ignore this email.';
      await transporter.sendMail({
        from: `founditcheaper <${FROM}>`, to: winnerEmail,
        subject: 'Your founditcheaper banana game result',
        html: wHtml,
        text: wText,
      });
    } catch (e) {
      console.error('[flappy-end-notify] winner email failed, will retry:', e.message);
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'winner email failed, will retry' }) };
    }
  }

  // 8) Erik's summary email (required).
  const subject = winner
    ? `Flappy Banana ended (${range}) — winner: ${winner.username} (${winner.best_score} pts)`
    : `Flappy Banana ended (${range}) — no players`;
  let html = `<h2 style="margin:0 0 8px">Flappy Banana ended</h2><p style="margin:0 0 12px"><strong>Competition:</strong> ${esc(range)}${prize ? ` &middot; <strong>Prize:</strong> ${esc(prize)}` : ''}</p>`;
  if (winner) {
    html += `<p style="font-size:15px;margin:0 0 12px">🏆 <strong>Winner: ${esc(winner.username)}</strong> <span style="color:#888">#${esc(winner.player_tag || '?')}</span> — <strong>${winner.best_score} pts</strong><br><span style="color:#555">${esc(winner.email || '(no email on file)')}</span></p>`;
    html += winnerEmail
      ? `<p style="font-size:13px;color:#0a7d2c;margin:0 0 12px">We emailed the winner a confirm button. You'll get a second email the moment they click it — that confirms a real person is on the other end before you send the reward.</p>`
      : `<p style="font-size:13px;color:#b00;margin:0 0 12px">This winner has no email on file, so we could not send them a claim link. Reach out via their standings info.</p>`;
    html += `<p style="margin:0 0 4px"><strong>Top players:</strong></p><ol style="margin:0 0 12px;padding-left:20px">`;
    players.slice(0, 10).forEach(function (p) { html += `<li>${esc(p.username)} <span style="color:#888">#${esc(p.player_tag || '?')}</span> — ${p.best_score} pts — <span style="color:#555">${esc(p.email || '')}</span></li>`; });
    html += `</ol>`;
  } else {
    html += `<p>No one played this round.</p>`;
  }
  html += `<p style="color:#888;font-size:12px">Full standings + emails are in the admin panel → Flappy Banana.</p>`;
  try {
    await transporter.sendMail({ from: `founditcheaper <${FROM}>`, to: TO, subject: subject, html: html });
  } catch (e) {
    console.error('[flappy-end-notify] owner email failed, will retry:', e.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'owner email failed, will retry' }) };
  }

  // 9) Everything that should have sent, sent. NOW mark notified so it never repeats.
  try {
    await fetch(`${sbUrl}/rest/v1/settings`, {
      method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: 'flappy_notified_period', value: start }),
    });
  } catch (e) { console.error('[flappy-end-notify] marker write failed:', e.message); }

  console.log(`[flappy-end-notify] notified for ${range}, winner ${winner ? winner.username : 'none'}`);
  return { statusCode: 200, body: JSON.stringify({ ok: true, notified: start, winner: winner ? winner.username : null }) };
};
