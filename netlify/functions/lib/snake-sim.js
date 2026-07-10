// DETERMINISTIC HUNGRY BANANA (snake) SIMULATION.
//
// Single source of truth for how the game behaves. The SAME code runs in the browser
// (copied verbatim into founditcheaper-snake.html) and here on the server. Given the
// same seed and the same list of turns, both must produce the exact same score. That is
// what lets the server verify a run instead of trusting a number.
//
// This one is easier to trust than the Flappy sim: it is a pure INTEGER grid. The snake
// moves whole cells, so there is no floating-point state to drift between engines. The
// only float in the whole thing is `rand()` for food placement, and mulberry32 is
// integer arithmetic divided by 2^32, which is exact everywhere.
//
// RULES FOR EDITING: if you change a constant or a line of snStep(), make the identical
// change in founditcheaper-snake.html or every honest run gets rejected as a mismatch.
//
// The sim also reports `nominalMs`: how long the run SHOULD have taken at the game's own
// speed. The server compares that against the real elapsed time (which it measures with
// its own clock, from the moment it issued the run). That closes two holes a pure replay
// check leaves open:
//   * slow motion  - dropping the step rate to get more thinking time per move
//   * offline solve - computing a perfect run and submitting it instantly
// Neither can produce a run whose real duration matches its nominal duration.

const SN = {
  W: 20, H: 20,          // grid cells
  START_LEN: 3,
  BASE_MS: 150,          // ms per step at score 0
  MIN_MS: 70,            // fastest the snake ever moves
  SPEEDUP: 3,            // ms shaved off per banana eaten
};

// 0 = up, 1 = right, 2 = down, 3 = left
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
function snOpposite(a, b) { return (a + 2) % 4 === b; }

function snRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// How long one step takes at this score. Visual pacing on the client, and the yardstick
// the server uses to sanity-check how long the run really took.
function snStepMs(score) { return Math.max(SN.MIN_MS, SN.BASE_MS - score * SN.SPEEDUP); }

// Place the next banana on a free cell. Scanning the grid in a fixed order keeps this
// deterministic (and it can never loop forever the way rejection sampling can).
function snSpawnFood(s) {
  const occupied = new Set();
  for (let i = 0; i < s.body.length; i++) occupied.add(s.body[i].y * SN.W + s.body[i].x);
  const free = [];
  for (let c = 0; c < SN.W * SN.H; c++) if (!occupied.has(c)) free.push(c);
  if (!free.length) { s.won = true; s.food = null; return; }
  const cell = free[Math.floor(s.rand() * free.length)];
  s.food = { x: cell % SN.W, y: Math.floor(cell / SN.W) };
}

function snCreate(seed) {
  const cy = Math.floor(SN.H / 2);
  const cx = Math.floor(SN.W / 2);
  const body = [];
  for (let i = 0; i < SN.START_LEN; i++) body.push({ x: cx - i, y: cy });   // head first, facing right
  const s = { body, dir: 1, score: 0, steps: 0, dead: false, won: false, food: null, rand: snRng(seed) };
  snSpawnFood(s);
  return s;
}

// Advance exactly one step. `turn` is the direction the player asked for on this step,
// or null. A 180-degree reversal is ignored rather than fatal, same as the arcade rule.
function snStep(s, turn) {
  if (s.dead || s.won) return;
  if (turn !== null && turn !== undefined && !snOpposite(s.dir, turn)) s.dir = turn;

  const head = s.body[0];
  const nx = head.x + DX[s.dir];
  const ny = head.y + DY[s.dir];

  if (nx < 0 || nx >= SN.W || ny < 0 || ny >= SN.H) { s.dead = true; s.steps++; return; }   // wall

  const willGrow = !!(s.food && nx === s.food.x && ny === s.food.y);
  // The tail cell frees up as we move, so it only blocks us when we're growing.
  const limit = willGrow ? s.body.length : s.body.length - 1;
  for (let i = 0; i < limit; i++) {
    if (s.body[i].x === nx && s.body[i].y === ny) { s.dead = true; s.steps++; return; }     // self
  }

  s.body.unshift({ x: nx, y: ny });
  if (willGrow) { s.score++; snSpawnFood(s); }
  else s.body.pop();
  s.steps++;
}

// Replay a run: same board (seed), same turns => the one true score.
// `turns` is [[stepIndex, dir], ...] with strictly increasing stepIndex.
function snSimulate(seed, turns, maxSteps) {
  const at = new Map();
  for (let i = 0; i < turns.length; i++) at.set(turns[i][0], turns[i][1]);
  const s = snCreate(seed);
  let nominalMs = 0;
  for (let step = 0; step < maxSteps && !s.dead && !s.won; step++) {
    nominalMs += snStepMs(s.score);
    snStep(s, at.has(step) ? at.get(step) : null);
  }
  return { score: s.score, steps: s.steps, nominalMs, dead: s.dead, won: s.won };
}

module.exports = { SN, snSimulate, snStepMs };
