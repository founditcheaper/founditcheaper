// DETERMINISTIC FLAPPY BANANA SIMULATION.
//
// This is the single source of truth for how the game behaves. The SAME code runs in
// the browser (copied verbatim into founditcheaper-flappy.html) and here on the server.
// Given the same seed and the same list of flap ticks, both must produce the exact same
// score, which is what lets the server verify a run instead of trusting a number.
//
// RULES FOR EDITING (read this before you touch anything):
//   * If you change a constant or a line of stepOnce(), you MUST make the identical
//     change in founditcheaper-flappy.html. Otherwise every legitimate run gets
//     rejected as a mismatch.
//   * Use only +, -, *, /, comparisons, Math.min/max/imul. These are exactly specified
//     by IEEE-754 and give bit-identical results in every JS engine. Do NOT use
//     Math.sin/cos/pow/random here, or floats will drift between browser and server.
//   * Anything purely visual (banana tilt, parallax dots) stays OUT of the sim.

const FS = {
  LW: 360, LH: 560, GROUND_H: 46,
  GRAVITY: 1500, FLAP_V: -430,
  PIPE_W: 60, BASE_SPEED: 150, BASE_GAP: 165, PIPE_INTERVAL: 210,
  BANANA_X: 96, BANANA_R: 15,
  MARGIN: 44,
  DT: 1 / 60,             // fixed timestep: the game advances in ticks, never in frames
};

// mulberry32: tiny, fast, integer-only PRNG. Deterministic across engines.
function fsRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fsSpeed(score) { return FS.BASE_SPEED + Math.min(score * 3, 95); }
function fsGap(score) { return Math.max(FS.BASE_GAP - Math.min(score * 1.2, 40), 125); }

function fsCreate(seed) {
  return {
    y: FS.LH / 2, v: 0,
    spawnAcc: FS.PIPE_INTERVAL,   // so the first pillar spawns on the first tick
    score: 0, pipes: [], tick: 0, dead: false,
    rand: fsRng(seed),
  };
}

function fsSpawn(s) {
  const gap = fsGap(s.score);
  const minTop = FS.MARGIN;
  const maxTop = FS.LH - FS.GROUND_H - gap - FS.MARGIN;
  const gapY = minTop + s.rand() * Math.max(10, maxTop - minTop);
  s.pipes.push({ x: FS.LW + 8, gapY: gapY, gapH: gap, scored: false });
}

function fsHits(s, p) {
  const bx = FS.BANANA_X, by = s.y, r = FS.BANANA_R - 1;
  if (bx + r < p.x || bx - r > p.x + FS.PIPE_W) return false;          // horizontally clear
  if (by - r > p.gapY && by + r < p.gapY + p.gapH) return false;       // safely inside the gap
  return true;
}

// Advance exactly one tick. `flap` is true if the player tapped on this tick.
function fsStep(s, flap) {
  if (s.dead) return;
  if (flap) s.v = FS.FLAP_V;
  s.v += FS.GRAVITY * FS.DT;
  s.y += s.v * FS.DT;
  if (s.y < FS.BANANA_R) { s.y = FS.BANANA_R; if (s.v < 0) s.v = 0; }   // soft ceiling

  const sp = fsSpeed(s.score);
  s.spawnAcc += sp * FS.DT;
  if (s.spawnAcc >= FS.PIPE_INTERVAL) { s.spawnAcc -= FS.PIPE_INTERVAL; fsSpawn(s); }

  for (let i = s.pipes.length - 1; i >= 0; i--) {
    const p = s.pipes[i];
    p.x -= sp * FS.DT;
    if (!p.scored && p.x + FS.PIPE_W < FS.BANANA_X - FS.BANANA_R) { p.scored = true; s.score++; }
    if (p.x + FS.PIPE_W < -10) s.pipes.splice(i, 1);
  }

  if (s.y + FS.BANANA_R >= FS.LH - FS.GROUND_H) { s.dead = true; s.tick++; return; }   // ground
  for (let j = 0; j < s.pipes.length; j++) {
    if (fsHits(s, s.pipes[j])) { s.dead = true; s.tick++; return; }
  }
  s.tick++;
}

// Replay a run: same course (seed), same taps (flapTicks) => the one true score.
function fsSimulate(seed, flapTicks, maxTicks) {
  const flaps = new Set(flapTicks);
  const s = fsCreate(seed);
  for (let t = 0; t < maxTicks && !s.dead; t++) fsStep(s, flaps.has(t));
  return { score: s.score, ticks: s.tick, dead: s.dead };
}

module.exports = { FS, fsSimulate };
