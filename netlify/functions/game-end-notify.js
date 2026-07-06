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
    const r = await fetch(`${sbUrl}/rest/v1/game_scores?week_start=eq.${encodeURIComponent(start)}&select=id,username,player_tag,email,week_score,claim_token,claimed_at&order=week_score.desc&limit=2000`, { headers: H });
    const rows = await r.json();
    if (Array.isArray(rows)) players = rows;
  } catch (e) { console.error('[game-end-notify] scores read failed:', e.message); }

  // Add the referral bonus — the SAME total the public leaderboard shows — so the true
  // winner wins. Raw week_score alone under-counts anyone who earned referral points, which
  // would send the prize to the wrong person.
  try {
    const rb = await fetch(`${sbUrl}/rest/v1/game_leaderboard?week_start=eq.${encodeURIComponent(start)}&select=player_tag,referral_bonus`, { headers: H });
    const brows = await rb.json();
    const bmap = {};
    if (Array.isArray(brows)) brows.forEach(function (x) { bmap[x.player_tag] = Number(x.referral_bonus) || 0; });
    players.forEach(function (p) { p.total_score = (Number(p.week_score) || 0) + (bmap[p.player_tag] || 0); });
  } catch (e) { players.forEach(function (p) { p.total_score = Number(p.week_score) || 0; }); }
  players.sort(function (a, b) { return (b.total_score || 0) - (a.total_score || 0); });

  const range = start === end ? start : (start + ' to ' + end);
  const prizes = [settings.game_prize || '', settings.game_prize_2 || '', settings.game_prize_3 || ''];
  const placeName = ['1st', '2nd', '3rd'];

  // The top 3 finishers by TOTAL score (base + referral bonus), each with a real score.
  // Fewer than 3 players (or fewer with a score) just yields a shorter podium.
  const winners = players.slice(0, 3).filter(function (p) { return (p.total_score || 0) > 0; });

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: true,
    auth: { user: FROM, pass: process.env.PRIVATE_EMAIL_PASS },
  });

  // Give each winner a one-time claim token AND stamp their place, so the claim page can
  // reveal the right prize and mark the right person confirmed. Reuse an existing token.
  for (let i = 0; i < winners.length; i++) {
    const w = winners[i];
    let token = w.claim_token || '';
    if (!token) token = crypto.randomBytes(16).toString('hex');
    w._token = token;
    await fetch(`${sbUrl}/rest/v1/game_scores?id=eq.${encodeURIComponent(w.id)}`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ claim_token: token, win_place: i + 1 }),
    }).catch(function () { w._token = ''; });
  }

  const winner = winners[0];
  const subject = winner
    ? `Dice game ended (${range}) — winner: ${winner.username} (${winner.total_score} pts)`
    : `Dice game ended (${range}) — no players`;

  // 6) Erik's summary email: the podium (place + prize + email) + full standings.
  let html = `<h2 style="margin:0 0 8px">Dice game ended</h2><p style="margin:0 0 12px"><strong>Competition:</strong> ${esc(range)}</p>`;
  if (winners.length) {
    html += `<p style="margin:0 0 6px"><strong>Winners (top ${winners.length}):</strong></p><ol style="margin:0 0 12px;padding-left:20px">`;
    winners.forEach(function (w, i) {
      const pr = prizes[i];
      const em = String(w.email || '').trim();
      html += `<li style="margin-bottom:6px">${placeName[i]} place — <strong>${esc(w.username)}</strong> <span style="color:#888">#${esc(w.player_tag || '?')}</span> — <strong>${w.total_score} pts</strong>` +
        (pr ? ` — prize: <strong>${esc(pr)}</strong>` : ` — <span style="color:#b00">no prize set for this place</span>`) +
        `<br><span style="color:#555">${esc(em || '(no email on file)')}</span></li>`;
    });
    html += `</ol>`;
    const anyEmailed = winners.some(function (w) { return String(w.email || '').trim() && w._token; });
    html += anyEmailed
      ? `<p style="font-size:13px;color:#0a7d2c;margin:0 0 12px">Each winner with an email on file got a "confirm it is you" button. You'll get a separate email the moment each one clicks it, before you send anything.</p>`
      : `<p style="font-size:13px;color:#b00;margin:0 0 12px">No winner has an email on file, so we could not send claim links. Reach out via their standings info.</p>`;
    html += `<p style="margin:0 0 4px"><strong>Full standings:</strong></p><ol style="margin:0 0 12px;padding-left:20px">`;
    players.slice(0, 10).forEach(function (p) { html += `<li>${esc(p.username)} <span style="color:#888">#${esc(p.player_tag || '?')}</span> — ${p.total_score} pts — <span style="color:#555">${esc(p.email || '')}</span></li>`; });
    html += `</ol>`;
  } else {
    html += `<p>No one scored this round.</p>`;
  }
  html += `<p style="color:#888;font-size:12px">Full standings + emails are in the admin panel → Games → Dice Game.</p>`;

  // Send to Erik (required).
  try {
    await transporter.sendMail({ from: `founditcheaper <${FROM}>`, to: TO, subject: subject, html: html });
  } catch (e) {
    console.error('[game-end-notify] owner email send failed:', e.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'send failed: ' + String(e.message).slice(0, 160) }) };
  }

  // Email each winner their confirm button (best-effort). Wording is place-agnostic and
  // deliverability-safe (no gift card / prize / won / free / $ amounts). The exact place
  // and prize are revealed on the confirmation page, which isn't spam-filtered.
  for (let i = 0; i < winners.length; i++) {
    const w = winners[i];
    const wEmail = String(w.email || '').trim();
    if (!wEmail || !w._token) continue;
    try {
      const claimUrl = 'https://founditcheaper.net/claim-prize/' + w._token;
      const wHtml =
        '<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:520px;font-size:15px;line-height:1.55">' +
          '<p style="margin:0 0 12px">Hey, you finished as one of the top players in the founditcheaper dice game this round.</p>' +
          '<p style="margin:0 0 14px">Before we sort out the details, confirm it is really you:</p>' +
          '<p style="margin:0 0 16px"><a href="' + claimUrl + '" style="background:#f5c842;color:#0a1a2f;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:6px;display:inline-block">Confirm it is me</a></p>' +
          '<p style="margin:0 0 14px;color:#333">Or just reply to this email with a yes, and we will take it from there.</p>' +
          '<p style="font-size:13px;color:#555;margin:0 0 4px">Why the step: emails get missed sometimes, and not every address is a real person. This is how we know someone real is on the other end before we send anything out.</p>' +
          '<p style="font-size:12px;color:#999;margin:12px 0 0">If this was not you, you can ignore this email.</p>' +
        '</div>';
      const wText = 'You finished as one of the top players in the founditcheaper dice game this round. '
        + 'Confirm it is really you here: ' + claimUrl + '. Or reply to this email with a yes. '
        + 'We ask because emails get missed and not every address is a real person, so this tells us '
        + 'someone real is on the other end. If this was not you, ignore this email.';
      await transporter.sendMail({
        from: `founditcheaper <${FROM}>`, to: wEmail,
        subject: 'Your founditcheaper dice game result',
        html: wHtml,
        text: wText,
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

  console.log(`[game-end-notify] emailed ${winners.length} winner(s) for ${range}`);
  return { statusCode: 200, body: JSON.stringify({ ok: true, notified: start, winners: winners.map(function (w) { return w.username; }) }) };
};
