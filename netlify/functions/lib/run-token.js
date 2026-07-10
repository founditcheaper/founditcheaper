// Signed run tokens, shared by every skill game on the site.
//
// The pattern, learned the hard way on Flappy Banana: the browser must never choose its
// own level, and must never report its own score. Instead the server issues a run — a
// random seed (which decides the board) plus a signature binding that seed to one email
// at one moment in time. When the player submits their inputs, the server checks the
// signature, replays the run, and computes the score itself.
//
// The signing key is derived from the service-role key rather than a new env var:
// Netlify caps total function env vars at ~4KB and this project sits near the limit.
// Deriving means there is nothing new to rotate or leak.
//
// Usage:
//   const { issueRun, verifyRun } = require('./lib/run-token');
//   const run = issueRun('snake', email);          // -> { runId, seed, issuedAt, sig }
//   const check = verifyRun('snake', email, body); // -> { ok } or { ok:false, error }

const crypto = require('crypto');

const RUN_MAX_AGE_MS = 2 * 60 * 60 * 1000;   // a run must be submitted within 2 hours
const FUTURE_SKEW_MS = 2 * 60 * 1000;        // tolerate a little clock skew

function signRun(game, runId, seed, issuedAt, email) {
  const key = 'run-token-v1:' + game + ':' + (process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  return crypto.createHmac('sha256', key)
    .update(`${game}|${runId}|${seed}|${issuedAt}|${email}`)
    .digest('hex');
}

function safeEqualHex(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length !== B.length) return false;      // length check first: timingSafeEqual throws otherwise
  return crypto.timingSafeEqual(A, B);
}

function issueRun(game, email) {
  const runId = crypto.randomBytes(12).toString('hex');
  const seed = crypto.randomBytes(4).readUInt32BE(0);
  const issuedAt = Date.now();
  return { runId, seed, issuedAt, sig: signRun(game, runId, seed, issuedAt, email) };
}

// Validates shape, signature and freshness. Returns { ok:true, seed, issuedAt } or
// { ok:false, status, error }.
function verifyRun(game, email, body) {
  const runId = String(body.runId || '');
  const seed = Number(body.seed);
  const issuedAt = Number(body.issuedAt);
  const sig = String(body.sig || '');

  if (!/^[a-f0-9]{24}$/.test(runId) ||
      !Number.isInteger(seed) || seed < 0 || seed > 0xFFFFFFFF ||
      !Number.isFinite(issuedAt) || !/^[a-f0-9]{64}$/.test(sig)) {
    return { ok: false, status: 400, error: 'Invalid run' };
  }
  if (!safeEqualHex(sig, signRun(game, runId, seed, issuedAt, email))) {
    return { ok: false, status: 403, error: 'Run signature invalid' };
  }
  const now = Date.now();
  if (issuedAt > now + FUTURE_SKEW_MS || now - issuedAt > RUN_MAX_AGE_MS) {
    return { ok: false, status: 403, error: 'Run expired' };
  }
  return { ok: true, seed, issuedAt, elapsedMs: now - issuedAt };
}

module.exports = { issueRun, verifyRun, RUN_MAX_AGE_MS };
