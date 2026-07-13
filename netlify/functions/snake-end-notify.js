// Scheduled (hourly): when a Hungry Banana competition ends, email the top 3 a
// "confirm it's you" button AND email Erik the standings — once per game.
//
// Copies the dice game's podium logic. There is no bonus system here: the score is the
// number of bananas eaten, verified by replay, so the leaderboard, the admin standings
// and this winner pick all rank by the same single number. (That is exactly the trap the
// dice game fell into when referral points lived somewhere else.)
//
// Deliverability: the winner email avoids the words spam filters hate (gift card, prize,
// won, free, $ amounts). The reward is revealed on the confirmation web page.
//
// REQUIRED env: PRIVATE_EMAIL_PASS. OPTIONAL: GAME_ALERT_TO, PRIVATE_EMAIL_USER.

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
  if (!sbUrl || !sbKey) { console.error('[snake-end-notify] missing supabase env'); return { statusCode: 500, body: 'config error' }; }
  const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  const settings = {};
  try {
    const r = await fetch(`${sbUrl}/rest/v1/settings?select=key,value`, { headers: H });
    const rows = await r.json();
    if (Array.isArray(rows)) rows.forEach(function (x) { settings[x.key] = x.value; });
  } catch (e) { console.error('[snake-end-notify] settings read failed:', e.message); return { statusCode: 200, body: 'settings read failed' }; }

  const start = settings.snake_period_start || '';
  const end   = settings.snake_period_end || '';
  const forceEnded = String(settings.snake_ended || '0') === '1';
  if (!start || !end) return { statusCode: 200, body: JSON.stringify({ ok: true, skip: 'no game configured' }) };

  const ended = forceEnded || todayCT() > end;
  if (!ended) return { statusCode: 200, body: JSON.stringify({ ok: true, skip: 'game still live' }) };

  if ((settings.snake_notified_period || '') === start) return { statusCode: 200, body: JSON.stringify({ ok: true, skip: 'already notified' }) };

  if (!process.env.PRIVATE_EMAIL_PASS) {
    console.warn('[snake-end-notify] PRIVATE_EMAIL_PASS not set — cannot send yet');
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'PRIVATE_EMAIL_PASS not set' }) };
  }

  // A successful standings read is REQUIRED. If it fails, return without marking so the
  // next hourly run retries, rather than wrongly reporting "no players" and giving up.
  let players;
  try {
    const r = await fetch(`${sbUrl}/rest/v1/snake_scores?period_start=eq.${encodeURIComponent(start)}&select=id,username,player_tag,email,best_score,claim_token,claimed_at&order=best_score.desc&limit=25`, { headers: H });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error('unexpected shape');
    players = rows;
  } catch (e) {
    console.error('[snake-end-notify] standings read failed, will retry:', e.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'standings read failed, will retry' }) };
  }

  const range = start === end ? start : (start + ' to ' + end);
  const prizes = [settings.snake_prize || '', settings.snake_prize_2 || '', settings.snake_prize_3 || ''];
  const placeName = ['1st', '2nd', '3rd'];
  const winners = players.slice(0, 3).filter(function (p) { return (p.best_score || 0) > 0; });

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: true,
    auth: { user: FROM, pass: process.env.PRIVATE_EMAIL_PASS },
  });

  // Give each winner a one-time claim token AND stamp their place. The token must be
  // CONFIRMED saved before we email that winner, or their confirm link would point at a
  // token that isn't in the database. If a save fails, bail without marking so we retry.
  for (let i = 0; i < winners.length; i++) {
    const w = winners[i];
    let token = w.claim_token || '';
    const alreadyHadToken = !!token;
    if (!token) token = crypto.randomBytes(16).toString('hex');
    let saved = alreadyHadToken;
    try {
      const pr = await fetch(`${sbUrl}/rest/v1/snake_scores?id=eq.${encodeURIComponent(w.id)}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ claim_token: token, win_place: i + 1 }),
      });
      saved = pr.ok;
    } catch (e) { console.error('[snake-end-notify] token save threw:', e.message); }
    if (!saved && String(w.email || '').trim()) {
      console.error('[snake-end-notify] claim token save failed for a winner, will retry');
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'token save failed, will retry' }) };
    }
    w._token = saved ? token : '';
  }

  const winner = winners[0];
  const subject = winner
    ? `Hungry Banana ended (${range}) — winner: ${winner.username} (${winner.best_score})`
    : `Hungry Banana ended (${range}) — no players`;

  let html = `<h2 style="margin:0 0 8px">Hungry Banana ended</h2><p style="margin:0 0 12px"><strong>Competition:</strong> ${esc(range)}</p>`;
  if (winners.length) {
    html += `<p style="margin:0 0 6px"><strong>Winners (top ${winners.length}):</strong></p><ol style="margin:0 0 12px;padding-left:20px">`;
    winners.forEach(function (w, i) {
      const pr = prizes[i];
      const em = String(w.email || '').trim();
      html += `<li style="margin-bottom:6px">${placeName[i]} place — <strong>${esc(w.username)}</strong> <span style="color:#888">#${esc(w.player_tag || '?')}</span> — <strong>${w.best_score} bananas</strong>` +
        (pr ? ` — prize: <strong>${esc(pr)}</strong>` : ` — <span style="color:#b00">no prize set for this place</span>`) +
        `<br><span style="color:#555">${esc(em || '(no email on file)')}</span></li>`;
    });
    html += `</ol>`;
    const anyEmailed = winners.some(function (w) { return String(w.email || '').trim() && w._token; });
    html += anyEmailed
      ? `<p style="font-size:13px;color:#0a7d2c;margin:0 0 12px">Each winner with an email on file got a "confirm it is you" button. You'll get a separate email the moment each one clicks it, before you send anything.</p>`
      : `<p style="font-size:13px;color:#b00;margin:0 0 12px">No winner has an email on file, so we could not send claim links.</p>`;
    html += `<p style="font-size:12px;color:#888;margin:0 0 12px">Every score here was verified by replaying the player's own inputs on the board the server issued them, so these are real runs.</p>`;
    html += `<p style="margin:0 0 4px"><strong>Full standings:</strong></p><ol style="margin:0 0 12px;padding-left:20px">`;
    players.slice(0, 10).forEach(function (p) { html += `<li>${esc(p.username)} <span style="color:#888">#${esc(p.player_tag || '?')}</span> — ${p.best_score} — <span style="color:#555">${esc(p.email || '')}</span></li>`; });
    html += `</ol>`;
  } else {
    html += `<p>No one scored this round.</p>`;
  }
  html += `<p style="color:#888;font-size:12px">Full standings + emails are in the admin panel → Games → Hungry Banana.</p>`;

  try {
    await transporter.sendMail({ from: `founditcheaper <${FROM}>`, to: TO, subject, html });
  } catch (e) {
    console.error('[snake-end-notify] owner email send failed:', e.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'send failed: ' + String(e.message).slice(0, 160) }) };
  }

  let allWinnersEmailed = true;
  for (let i = 0; i < winners.length; i++) {
    const w = winners[i];
    const wEmail = String(w.email || '').trim();
    if (!wEmail || !w._token) continue;
    try {
      const claimUrl = 'https://founditcheaper.net/claim-snake/' + w._token;
      const wHtml =
        '<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:520px;font-size:15px;line-height:1.55">' +
          '<p style="margin:0 0 12px">Hey, you finished as one of the top players in the founditcheaper banana game this round.</p>' +
          '<p style="margin:0 0 14px">Before we sort out the details, confirm it is really you:</p>' +
          '<p style="margin:0 0 16px"><a href="' + claimUrl + '" style="background:#f5c842;color:#0a1a2f;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:6px;display:inline-block">Confirm it is me</a></p>' +
          '<p style="margin:0 0 14px;color:#333">Or just reply to this email with a yes, and we will take it from there.</p>' +
          '<p style="font-size:13px;color:#555;margin:0 0 4px">Why the step: emails get missed sometimes, and not every address is a real person. This is how we know someone real is on the other end before we send anything out.</p>' +
          '<p style="font-size:12px;color:#999;margin:12px 0 0">If this was not you, you can ignore this email.</p>' +
        '</div>';
      const wText = 'You finished as one of the top players in the founditcheaper banana game this round. '
        + 'Confirm it is really you here: ' + claimUrl + '. Or reply to this email with a yes. '
        + 'If this was not you, ignore this email.';
      await transporter.sendMail({
        from: `founditcheaper <${FROM}>`, to: wEmail,
        subject: 'Your founditcheaper banana game result',
        html: wHtml, text: wText,
      });
    } catch (e) { console.error('[snake-end-notify] winner email failed:', e.message); allWinnersEmailed = false; }
  }

  // If a winner who should have been emailed wasn't, don't mark — retry next hour.
  if (!allWinnersEmailed) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'a winner email failed, will retry' }) };
  }

  try {
    await fetch(`${sbUrl}/rest/v1/settings`, {
      method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: 'snake_notified_period', value: start }),
    });
  } catch (e) { console.error('[snake-end-notify] marker write failed:', e.message); }

  console.log(`[snake-end-notify] emailed ${winners.length} winner(s) for ${range}`);
  return { statusCode: 200, body: JSON.stringify({ ok: true, notified: start, winners: winners.map(function (w) { return w.username; }) }) };
};
