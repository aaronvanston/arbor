import type { AppTheme } from '../theme';
import { MOST_TURNED, seasonShade, seasonTurn, turnedGreen, type AppColor } from './appColor';

/**
 * The sidebar's scenes: Arbor's greens, with their leaves turned for the season chosen in Appearance (services/
 * appColor.ts), drawn in an 8×8 Bayer dither, one dot per CSS pixel. Each fills a strip the sidebar's width that starts 6px above the window
 * (SidebarArt places it), runs at full strength behind the title row (the wordmark and sidebar button carry a halo
 * instead, styles.css `art-halo`) and fades out above the search row, or for the canopy's falling leaves further down.
 * Pure, so the tests can check what they draw; components/sidebar/SidebarArt.tsx puts them on a canvas.
 *
 * - `aurora`: slow ribbons of light.
 * - `canopy`: leaves hanging along the top, now and then one falling past the search row and Home, as on arbor.onl's
 *   home page.
 *
 * A scene saved by an older version (`leaves`, Fields, Treeline, Meadow or Contours) opens as the canopy
 * (services/sidebarArt.ts).
 */
export type SceneName = 'aurora' | 'canopy';

/** How often a scene is redrawn while moving: they're slow enough that more isn't seen. */
export const SCENE_FPS = 15;
/**
 * How long a scene keeps moving after the last input (a key, the pointer, a scroll, Arbor coming forward). Past it, it
 * holds its frame until the next: moving costs about 5% of a core, and nobody watches it through a minute away (the
 * owner's call, 2026-10-08).
 */
export const SCENE_REST_AFTER_MS = 60_000;
/** Whether a scene last woken by input at `lastInputMs` rests at `nowMs`. */
export const sceneResting = (lastInputMs: number, nowMs: number) => nowMs - lastInputMs >= SCENE_REST_AFTER_MS;

/** The moment drawn when a scene holds still (the Still setting, Reduce motion): one where each is well formed. */
export const SCENE_STILL_SECONDS = 24;

/**
 * A scene's clock. It moves only between `tick`s while running, so a scene paused while Arbor was behind other
 * windows carries on from where it was instead of jumping ahead, and a slow frame moves it at most 0.12s. `speed`
 * scales how far each frame moves it, for the Slow setting.
 */
export function sceneClock(fps = SCENE_FPS) {
  // A few ms of slack, as frames arrive on the display's beat.
  const gap = 1000 / fps - 4;
  let seconds = SCENE_STILL_SECONDS;
  let last: number | null = null;
  return {
    /** The moment to draw at `now` (ms, as requestAnimationFrame gives it), or null when no frame is due. */
    tick(now: number, speed = 1): number | null {
      if (last !== null) {
        const elapsed = now - last;
        if (elapsed < gap) return null;
        seconds += Math.min(0.12, elapsed / 1000) * speed;
      }
      last = now;
      return seconds;
    },
    /** Stops the clock until the next tick, which draws the moment it stopped at. */
    pause() {
      last = null;
    },
    /** The earliest `now` a tick draws at, in requestAnimationFrame's ms; null while paused, when the next one does. */
    get dueAt(): number | null {
      return last === null ? null : last + gap;
    },
    get seconds() {
      return seconds;
    },
  };
}

/**
 * How long before a frame is due a moving scene wakes to wait for display frames again. A scene draws one display frame
 * in four (at 60 Hz), so between its frames it sleeps on a timer rather than waking on every display frame to skip
 * it. Waking a little under a 60 Hz frame early means the first display frame after the wake is the one that was going
 * to draw anyway, so the scene draws the same moments at the same times, with room for a timer that fires late.
 */
export const SCENE_WAKE_EARLY_MS = 10;

/** How long to sleep after a frame drawn at `now` (ms, as requestAnimationFrame gives it), or 0 to wait on frames now. */
export function sceneWakeDelay(dueAt: number | null, now: number): number {
  return dueAt === null ? 0 : Math.max(0, dueAt - SCENE_WAKE_EARLY_MS - now);
}

// ---- Noise ----

const TABLE = 256;
const noiseTable = (() => {
  const table = new Float32Array(TABLE * TABLE);
  for (let i = 0; i < TABLE; i++) {
    for (let j = 0; j < TABLE; j++) {
      const n = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
      table[i * TABLE + j] = n - Math.floor(n);
    }
  }
  return table;
})();
const wrap = (n: number) => ((n % TABLE) + TABLE) % TABLE;
const at = (x: number, y: number) => noiseTable[wrap(x) * TABLE + wrap(y)] ?? 0;

function valueNoise(x: number, y: number) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
const fbm = (x: number, y: number) => 0.5 * valueNoise(x, y) + 0.3 * valueNoise(x * 2.1, y * 2.1) + 0.2 * valueNoise(x * 4.3, y * 4.3);
const smooth = (from: number, to: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
};
/** A steady random number for `a`, `b`, 0 to 1. */
const hash = (a: number, b = 0) => {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
};
const frac = (value: number) => value - Math.floor(value);

// ---- Scenes ----

/**
 * A scene fills `value` (how bright, 0 up, over 1 clipped), `drift` (which way its color leans, -1 cool to 1 warm) and
 * `ranks` (where what's drawn there comes among the season's leaves, 0 the greenest to 1 the most turned; see
 * services/appColor.ts `seasonTurn`) for each CSS px of a strip `cols` × `rows`, `seconds` in. `rows` is how tall that strip is (`SCENE_ROWS`, down
 * to the top of the search row, if unset) and `fade` is where the scene fades out before its foot. `rise`, if set,
 * starts it dimmer at the top edge (that share of its brightness) and brings it to full by that row; `strength` is how
 * much of its color its dots show over the sidebar, as a canvas's opacity would (1 if unset).
 */
interface Scene {
  rows?: number;
  fade: readonly [number, number];
  rise?: readonly [number, number];
  strength?: number;
  /**
   * Its picture over the light theme's sidebar, drawn straight as places on `LIGHT_TONES` (0 clear, up to its deepest
   * shade) into `place`, with `scratch` the same size to work in, and `ranks` as `draw` has them, or `SHADE` where it's
   * the shade between leaves. A scene with one lays its deep shade under the title row, which turns the wordmark and
   * sidebar button light. Without, its light dots take the two levels dark's do.
   */
  drawLight?(place: Float32Array, scratch: Float32Array, cols: number, rows: number, seconds: number, ranks: Float32Array): void;
  draw(value: Float32Array, drift: Float32Array, cols: number, rows: number, seconds: number, ranks: Float32Array): void;
}

/** The aurora is worked out on a lattice this many px apart, each point filling the square around it. */
const LATTICE = 2;
const aurora: Scene = {
  fade: [42, 74],
  draw(value, drift, cols, rows, t, ranks) {
    for (let j = 0; j * LATTICE < rows + LATTICE; j++) {
      for (let i = 0; i * LATTICE < cols + LATTICE; i++) {
        const x = i * LATTICE, y = j * LATTICE, nx = x / 60, ny = y / 60;
        const warp = fbm(nx * 0.8 + t * 0.05, ny * 0.8 - t * 0.03) * 2.2;
        const band = fbm(nx * 0.9 + warp - t * 0.08, ny * 2.4 + nx * 0.6 + t * 0.02);
        const glow = fbm(nx * 0.5 - t * 0.04, ny * 0.7 + 7);
        const v = ((1 - Math.abs(band * 2 - 1)) ** 3 * 0.85 + glow * glow * 0.5) * (0.35 + 0.65 * smooth(0, cols * 0.9, x));
        const d = (fbm(x / 90 + t * 0.03 + 40, y / 90) - 0.5) * 3;
        // The season turns it in slow drifting patches, as it does a canopy's leaves.
        const rank = smooth(0.3, 0.7, fbm(nx * 0.7 + t * 0.02 + 20, ny * 0.9 - 5));
        for (let row = Math.max(0, y - 1); row < Math.min(rows, y + 1); row++) {
          for (let col = Math.max(0, x - 1); col < Math.min(cols, x + 1); col++) {
            value[row * cols + col] = v;
            drift[row * cols + col] = d;
            ranks[row * cols + col] = rank;
          }
        }
      }
    }
  },
};

/** A leaf's outline: at `s` along it the blade is half · sin(πs)^0.8 wide. Tabled, as every dot reads it. */
const LEAF_PROFILE = Float32Array.from({ length: 129 }, (_, i) => Math.sin((i / 128) * Math.PI) ** 0.8);

/**
 * One leaf from its stem at `x`, `y`, pointing along `angle`, `length` px long, shaded as the site's leaves are (lit
 * toward the tip, a dark midrib, veins and rim), or with a `tone`, as that place on the light theme's tones. `width`
 * narrows the blade as a falling leaf turns edge-on, and `rank` is where it comes among the season's leaves, into
 * `ranks`. It covers what's under it, so leaves are painted back to front.
 */
function paintLeaf(
  value: Float32Array,
  drift: Float32Array,
  ranks: Float32Array,
  cols: number,
  rows: number,
  leaf: { x: number; y: number; length: number; angle: number; width: number; bright: number; lean: number; rank: number; tone?: number },
) {
  const { x, y, length, width, bright, lean } = leaf, half = length * 0.27 * width, cos = Math.cos(leaf.angle), sin = Math.sin(leaf.angle);
  if (half < 0.4 || bright < 0.02) return;
  const tipX = x + cos * length, tipY = y + sin * length, reach = half + 1;
  const x0 = Math.max(0, Math.floor(Math.min(x, tipX) - reach)), x1 = Math.min(cols - 1, Math.ceil(Math.max(x, tipX) + reach));
  const y0 = Math.max(0, Math.floor(Math.min(y, tipY) - reach)), y1 = Math.min(rows - 1, Math.ceil(Math.max(y, tipY) + reach));
  for (let row = y0; row <= y1; row++) {
    for (let col = x0; col <= x1; col++) {
      const dx = col + 0.5 - x, dy = row + 0.5 - y, along = dx * cos + dy * sin;
      if (along <= 0 || along >= length) continue;
      const s = along / length, across = dy * cos - dx * sin, off = Math.abs(across), edge = half * (LEAF_PROFILE[Math.floor(s * 128)] ?? 0);
      if (off > edge) continue;
      const midrib = off < 0.55, vein = !midrib && frac(s * 7 - (off / half) * 0.9) < 0.14, rim = off > edge - 0.8;
      ranks[row * cols + col] = leaf.rank;
      if (leaf.tone !== undefined) {
        // Its place on the light theme's tones: lit well toward the tip, so its dots thin along it as the dark theme's
        // do, with a pale midrib and veins and a deeper rim. It stays above 0 at its palest, so it counts as leaf, not a gap.
        const detail = 3 * (0.5 - s) - (midrib ? 1.4 : vein ? 0.8 : 0) + (rim ? 0.8 : 0);
        value[row * cols + col] = Math.max(0.01, leaf.tone + detail);
        continue;
      }
      let shade = 0.55 + 0.35 * s + 0.12 * (across / half);
      if (midrib) shade *= 0.5;
      else if (vein) shade *= 0.7;
      if (rim) shade *= 0.75;
      value[row * cols + col] = shade * bright;
      drift[row * cols + col] = lean;
    }
  }
}

/**
 * The canopy, laid out once for a strip `cols` × `rows`: leaves on a jittered grid in a band along the top, thick at
 * the edge and thinning below it in clumps, each hanging roughly downward and sorted back to front; and a few leaves
 * that fall from it, one for every 48px of width, each with its own pace, swing and turn. Each hanging leaf has its
 * rank among them for the season, from the greenest to the most turned: partly in patches, as a tree turns a branch at
 * a time, partly its own, and spread evenly from 0 to 1, so a season's shares of each color hold at any width.
 */
const CANOPY_GRID = 7, CANOPY_BAND = 92;
function canopyLayout(cols: number, rows: number) {
  const hanging: { x: number; y: number; length: number; angle: number; seed: number; depth: number; bright: number; lean: number; rank: number }[] = [];
  for (let j = -2; j * CANOPY_GRID < CANOPY_BAND; j++) {
    for (let i = -2; i * CANOPY_GRID < cols + 2 * CANOPY_GRID; i++) {
      const x = (i + hash(i, j + 50)) * CANOPY_GRID, y = (j + hash(i + 50, j)) * CANOPY_GRID - 4;
      const keep = (1 - smooth(0, CANOPY_BAND, y) ** 1.4) * (0.6 + 0.9 * fbm(x * 0.03, y * 0.05 + 3));
      if (hash(i + 7, j + 13) > keep) continue;
      const depth = hash(i + 1, j + 1);
      hanging.push({
        x,
        y,
        length: 13 + 12 * hash(i + 9, j + 3),
        angle: Math.PI / 2 + (hash(i + 3, j + 7) - 0.5) * 2,
        seed: hash(i, j),
        depth,
        bright: (0.4 + 0.6 * depth) * (1 - 0.5 * smooth(CANOPY_BAND * 0.2, CANOPY_BAND, y)),
        lean: (hash(i + 5, j + 11) - 0.5) * 2.4,
        rank: 0.65 * fbm(x * 0.014 + 31, y * 0.03 + 7) + 0.35 * hash(i + 11, j + 17),
      });
    }
  }
  [...hanging].sort((a, b) => a.rank - b.rank).forEach((leaf, place, all) => (leaf.rank = place / Math.max(1, all.length - 1)));
  hanging.sort((a, b) => a.depth - b.depth);
  const falling = Array.from({ length: Math.max(3, Math.round(cols / 48)) }, (_, f) => {
    const speed = 5 + 3 * hash(f, 71);
    return {
      speed,
      // Down past the strip's foot, then a rest before it falls again from somewhere new.
      period: (rows + 20) / speed + 3 + 8 * hash(f, 72),
      offset: hash(f, 73) * 200,
      length: 10 + 5 * hash(f, 74),
      swing: 4 + 4 * hash(f, 75),
      pace: (Math.PI * 2) / (5 + 3 * hash(f, 76)),
      turn: 0.5 + 0.5 * hash(f, 77),
      spin: (hash(f, 78) - 0.5) * 0.3,
      breeze: 0.2 + 0.4 * hash(f, 79),
    };
  });
  return { cols, rows, hanging, falling };
}
type Canopy = ReturnType<typeof canopyLayout>;
let canopyCache: Canopy | null = null;

/** A hanging leaf at `t`: a sway of its own, plus a slow swell traveling along the canopy like a breeze. */
function hangingAt(leaf: Canopy['hanging'][number], t: number) {
  const angle = leaf.angle + 0.16 * Math.sin(t * 0.5 + leaf.seed * 20) + 0.1 * Math.sin(t * 0.3 - leaf.x * 0.03);
  return { ...leaf, y: leaf.y + Math.sin(t * 0.4 + leaf.seed * 9), angle, width: 1 };
}

/** Falling leaf `f` at `t`, `life` seconds into this fall, or null while it rests below the strip. */
function fallingAt(leaf: Canopy['falling'][number], f: number, t: number, cols: number, rows: number) {
  const age = t + leaf.offset, round = Math.floor(age / leaf.period), life = age - round * leaf.period;
  const phase = leaf.pace * life + hash(f, round + 901) * Math.PI * 2;
  // Quicker through the bottom of each swing than at its ends, as a leaf falls.
  const y = 4 + 14 * hash(f + 40, round + 900) + leaf.speed * life - ((leaf.speed * 0.35) / (2 * leaf.pace)) * Math.cos(2 * phase);
  if (y > rows + leaf.length) return null;
  return {
    x: hash(f, round + 900) * cols + leaf.swing * Math.sin(phase) + leaf.breeze * life,
    y,
    length: leaf.length,
    angle: hash(f + 20, round) * Math.PI * 2 + leaf.spin * life + 0.55 * Math.cos(phase),
    width: 0.45 + 0.55 * Math.abs(Math.cos(leaf.turn * life + f)),
    rank: hash(f + 60, round + 950),
    life,
  };
}

/**
 * The canopy in the light theme, by how far down a leaf's middle hangs: `[px, tone, forward, lit]`. `tone` is its
 * place on `LIGHT_TONES`, `forward` how much deeper a leaf at the front is than one at the back, and `lit` how much
 * lighter the frontmost quarter are. Up in the canopy most leaves sit in deep shade and the frontmost are lit out of
 * it; lower down the front ones are the strongest greens and the rest pale away. It stops in leaves, well above the
 * search row, at `CANOPY_FOOT`.
 */
const CANOPY_LIGHT: readonly (readonly [number, number, number, number])[] = [
  [7, 11.5, 0, 4],
  [26, 10, 1, 3],
  [38, 8, 3, 1],
  [51, 5, 3.5, 0],
  [64, 2.8, 2.5, 0],
  [76, 1.3, 1.5, 0],
  [94, 0.4, 0.6, 0],
];
/**
 * Where the canopy stops, in both themes: a leaf that would hang its middle lower than this (give or take 6px) isn't
 * drawn, so it ends in leaves well above the search row, a leafy edge rather than a fade. Falling leaves still drift on
 * past it.
 */
const CANOPY_FOOT = 65;
const hangsAboveFoot = (leaf: Canopy['hanging'][number]) => leaf.y + leaf.length * 0.45 * Math.sin(leaf.angle) <= CANOPY_FOOT + 12 * (leaf.seed - 0.5);
function canopyLightTone(middle: number, depth: number) {
  const next = CANOPY_LIGHT.findIndex(([px]) => px > middle);
  const from = CANOPY_LIGHT[Math.max(0, next - 1)] ?? [0, 0, 0, 0], to = CANOPY_LIGHT[next < 0 ? CANOPY_LIGHT.length - 1 : next] ?? from;
  const share = to[0] > from[0] ? Math.min(1, Math.max(0, (middle - from[0]) / (to[0] - from[0]))) : 0;
  const [tone, forward, lit] = [1, 2, 3].map((k) => (from[k] ?? 0) + ((to[k] ?? 0) - (from[k] ?? 0)) * share) as [number, number, number];
  return tone + forward * (depth - 0.5) - lit * smooth(0.75, 1, depth);
}

/**
 * Shade in the gaps between the light canopy's leaves, as much as the leaves crowd round them (the share of the 9 × 9
 * square around a gap that's leaf) and less further down: deep where the canopy is thick, a pale haze where it thins,
 * so its edge follows the clumps instead of running straight across. Above the strip counts as leaf.
 */
function shadeGaps(place: Float32Array, scratch: Float32Array, cols: number, rows: number) {
  const r = 4, span = 2 * r + 1;
  for (let y = 0; y < rows; y++) {
    let sum = 0;
    for (let x = -r; x < cols + r; x++) {
      if (x + r < cols && (place[y * cols + x + r] ?? 0) > 0) sum++;
      if (x - r - 1 >= 0 && (place[y * cols + x - r - 1] ?? 0) > 0) sum--;
      if (x >= 0 && x < cols) scratch[y * cols + x] = sum / span;
    }
  }
  for (let x = 0; x < cols; x++) {
    let sum = r;
    for (let y = 0; y <= r && y < rows; y++) sum += scratch[y * cols + x] ?? 0;
    for (let y = 0; y < rows; y++) {
      const cell = y * cols + x, crowd = sum / span;
      if (!place[cell]) place[cell] = 11.5 * crowd * crowd * (1 - smooth(7, 60, y)) ** 1.6;
      sum += (y + r + 1 < rows ? (scratch[(y + r + 1) * cols + x] ?? 0) : 0) - (y - r >= 0 ? (scratch[(y - r) * cols + x] ?? 0) : 1);
    }
  }
}

/**
 * Leaves hanging from a canopy above the strip, as on arbor.onl's home page: the band sways, and every few seconds a
 * leaf lets go and drifts down past the title row and the search row, rocking and turning, to fade out past Home.
 */
const canopy: Scene = {
  // A taller strip, for the leaves falling past the search row and Home; the canopy itself stops at `CANOPY_FOOT`. The
  // search row and the tree sit over the falling leaves, faint by the time they're behind their text.
  rows: 152,
  // As the site's hero draws it: at a little over half strength, dimmed along the top edge, and fading out over most
  // of the strip rather than just its foot.
  fade: [32, 146],
  rise: [0.6, 22],
  strength: 0.6,
  // On white: see `CANOPY_LIGHT`.
  drawLight(place, scratch, cols, rows, t, ranks) {
    place.fill(0);
    ranks.fill(SHADE);
    if (canopyCache?.cols !== cols || canopyCache.rows !== rows) canopyCache = canopyLayout(cols, rows);
    for (const leaf of canopyCache.hanging) {
      if (!hangsAboveFoot(leaf)) continue;
      const at = hangingAt(leaf, t);
      paintLeaf(place, scratch, ranks, cols, rows, { ...at, tone: canopyLightTone(at.y + at.length * 0.45 * Math.sin(at.angle), leaf.depth) + 0.35 * leaf.lean });
    }
    canopyCache.falling.forEach((leaf, f) => {
      const at = fallingAt(leaf, f, t, cols, rows);
      if (at) paintLeaf(place, scratch, ranks, cols, rows, { ...at, bright: 1, lean: 0, tone: canopyLightTone(at.y + at.length * 0.45 * Math.sin(at.angle), 1) * smooth(0, 3, at.life) });
    });
    shadeGaps(place, scratch, cols, rows);
    // Thinning to pale dots as it reaches the search row, whose label starts 84 rows down the strip, so its muted text
    // keeps 4.5:1 over whatever hangs there; a falling leaf fades out past Home, as in the dark theme.
    for (let y = 60; y < rows; y++) {
      const most = (0.7 + 11.3 * (1 - smooth(60, 84, y))) * (1 - smooth(104, 146, y));
      for (let cell = y * cols; cell < (y + 1) * cols; cell++) place[cell] = Math.min(place[cell] ?? 0, most);
    }
  },
  draw(value, drift, cols, rows, t, ranks) {
    value.fill(0);
    drift.fill(0);
    if (canopyCache?.cols !== cols || canopyCache.rows !== rows) canopyCache = canopyLayout(cols, rows);
    for (const leaf of canopyCache.hanging) if (hangsAboveFoot(leaf)) paintLeaf(value, drift, ranks, cols, rows, hangingAt(leaf, t));
    canopyCache.falling.forEach((leaf, f) => {
      const at = fallingAt(leaf, f, t, cols, rows);
      if (at) paintLeaf(value, drift, ranks, cols, rows, { ...at, bright: 1.05 * smooth(0, 3, at.life), lean: 0.6 });
    });
  },
};

const SCENES: Record<SceneName, Scene> = { aurora, canopy };

/** A scene's strip unless it asks for more: 80px, from 6px above the window to the top of the search row. */
export const SCENE_ROWS = 80;
/** How tall a strip scene `name` is drawn in, in CSS px. */
export const sceneRows = (name: SceneName) => SCENES[name].rows ?? SCENE_ROWS;

// ---- Drawing ----

/** Where the shade between the light canopy's leaves comes among a season's leaves: none, it's the season's own shade. */
const SHADE = -1;
/** How finely a leaf's turn is told apart: this many steps from one color to the next (services/appColor.ts). */
const TURN_STEPS = 8;
const LAST_TURN_STEP = MOST_TURNED * TURN_STEPS;
/** A rank, 0 to 1, as the index `seasonSteps` reads a step at. */
const RANK_SLOTS = 256;
const rankSlot = (rank: number) => Math.min(RANK_SLOTS, Math.max(0, Math.round(rank * RANK_SLOTS)));
const seasons = new Map<AppColor, { steps: Uint8Array; shade: number }>();
/** For season `color`, the turn step of the leaf at each rank slot, and of the shade. */
function seasonSteps(color: AppColor) {
  const known = seasons.get(color);
  if (known) return known;
  const toStep = (turn: number) => Math.min(LAST_TURN_STEP, Math.max(0, Math.round(turn * TURN_STEPS)));
  const steps = Uint8Array.from({ length: RANK_SLOTS + 1 }, (_, slot) => toStep(seasonTurn(color, slot / RANK_SLOTS)));
  const season = { steps, shade: toStep(seasonShade(color)) };
  seasons.set(color, season);
  return season;
}

/** The scenes' own ranks when a caller doesn't need them (sceneValues from the tests), kept to the strip's size. */
let spareRanks = new Float32Array(0);
const ranksFor = (size: number) => (spareRanks.length === size ? spareRanks : (spareRanks = new Float32Array(size)));

/**
 * Fills `value` and `drift` with scene `name` at `seconds` for a strip `cols` × `rows`, then clips it to 1, dims its top
 * edge where the scene rises in, and fades it out above the search row: what the dither draws. The title row isn't
 * dimmed, which would leave a pale bar behind the window buttons and wordmark; they keep their contrast with a halo
 * instead. `ranks` takes where each dot comes among the season's leaves.
 */
export function sceneValues(name: SceneName, value: Float32Array, drift: Float32Array, cols: number, rows: number, seconds: number, ranks = ranksFor(cols * rows)) {
  const scene = SCENES[name];
  scene.draw(value, drift, cols, rows, seconds, ranks);
  for (let y = 0; y < rows; y++) {
    const top = scene.rise ? scene.rise[0] + (1 - scene.rise[0]) * smooth(0, scene.rise[1], y) : 1;
    const below = top * (1 - smooth(scene.fade[0], scene.fade[1], y)) ** 1.3;
    for (let x = 0; x < cols; x++) {
      const cell = y * cols + x;
      value[cell] = Math.min(1, Math.max(0, value[cell] ?? 0)) * below;
    }
  }
}

type Rgb = readonly [number, number, number];
type Palette = { ground: Rgb; cool: Rgb; middle: Rgb; warm: Rgb; glow: Rgb | null };
/**
 * Arbor's greens, from the brand's forest and leaf ramps: `middle` where the color rests, `cool` and `warm` where it
 * drifts, and in the dark `glow` for the brightest dots. The light theme's are a step or two deeper, to show on white.
 * `ground` is the sidebar's own color. A turned leaf's are these, turned (`scenePalettes`).
 */
export const SCENE_PALETTE: Record<AppTheme, Palette> = {
  dark: { ground: [0, 0, 0], cool: [64, 127, 111], middle: [34, 166, 99], warm: [55, 204, 125], glow: [187, 249, 207] },
  light: { ground: [250, 250, 250], cool: [21, 73, 63], middle: [34, 166, 99], warm: [19, 125, 74], glow: null },
};
const palettes: Partial<Record<AppTheme, readonly Palette[]>> = {};
/** The palette in `theme` at each turn step, from green to red: the greens turned, on the same ground. */
function scenePalettes(theme: AppTheme): readonly Palette[] {
  const known = palettes[theme];
  if (known) return known;
  const green = SCENE_PALETTE[theme];
  const made = Array.from({ length: LAST_TURN_STEP + 1 }, (_, step) => {
    const turn = (rgb: Rgb) => turnedGreen(rgb, step / TURN_STEPS);
    return { ground: green.ground, cool: turn(green.cool), middle: turn(green.middle), warm: turn(green.warm), glow: green.glow && turn(green.glow) };
  });
  palettes[theme] = made;
  return made;
}
/** How much of its color a dot at the dim level shows over the sidebar. The full level shows all of it. */
const SCENE_DIM: Record<AppTheme, number> = { dark: 0.4, light: 0.3 };
/**
 * How faint a spot may be and still get dots. In the light theme the faintest dim dots read as a gray haze on white,
 * so they're left out there.
 */
const THRESHOLD: Record<AppTheme, number> = { dark: 0, light: 0.1 };

const BAYER = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21].map((v) => (v + 0.5) / 64);

/** A dot's level at brightness `value` in Bayer cell `col`, `row`: 0 none, 1 dim, 2 full. */
function sceneLevel(value: number, col: number, row: number, theme: AppTheme): 0 | 1 | 2 {
  const scaled = Math.max(0, value - THRESHOLD[theme]) * 2.2;
  const whole = Math.floor(scaled);
  const level = whole + (scaled - whole > (BAYER[(row & 7) * 8 + (col & 7)] ?? 0.5) ? 1 : 0);
  return level <= 0 ? 0 : level === 1 ? 1 : 2;
}

/** A dot's color, before the dim level thins it: the palette's middle leaning by `drift`, glowing at the brightest. */
function sceneColor(palette: Palette, drift: number, value: number): Rgb {
  const toward = drift >= 0 ? palette.warm : palette.cool, share = Math.min(1, Math.abs(drift));
  const glow = palette.glow, lift = glow ? smooth(0.7, 1, value) * 0.5 : 0;
  const channel = (k: 0 | 1 | 2) => {
    const mixed = palette.middle[k] + (toward[k] - palette.middle[k]) * share;
    return glow ? mixed + (glow[k] - mixed) * lift : mixed;
  };
  return [channel(0), channel(1), channel(2)];
}

/** `color` laid over `ground` at `share`, packed as one opaque ImageData pixel. */
const pack = ([r, g, b]: Rgb, [gr, gg, gb]: Rgb, share: number) => {
  const mix = (over: number, under: number) => Math.round(under + (over - under) * share);
  return ((255 << 24) | (mix(b, gb) << 16) | (mix(g, gg) << 8) | mix(r, gr)) >>> 0;
};

/**
 * The light theme's greens, from the sidebar (left clear) to the deepest shade, saturated all the way, since a green
 * thinned over white turns gray. A scene's tone picks a place on it. A turned leaf's are these turned, as the dark
 * theme's are, all but the sidebar's own.
 */
const LIGHT_TONES: readonly Rgb[] = [
  [250, 250, 250], [227, 247, 235], [204, 238, 217], [176, 223, 193], [143, 206, 164], [114, 189, 140], [87, 171, 117],
  [64, 152, 96], [43, 132, 78], [25, 111, 62], [13, 88, 48], [8, 63, 36], [5, 39, 23],
];
let lightTones: readonly { tones: readonly Rgb[]; pixels: readonly number[] }[] | null = null;
/** `LIGHT_TONES` at each turn step, from green to red, with each as an ImageData pixel. */
function lightTonesByStep() {
  lightTones ??= Array.from({ length: LAST_TURN_STEP + 1 }, (_, step) => {
    const tones = LIGHT_TONES.map((rgb, place) => (place ? turnedGreen(rgb, step / TURN_STEPS) : rgb));
    return { tones, pixels: tones.map((rgb) => pack(rgb, rgb, 1)) };
  });
  return lightTones;
}
/**
 * A light dot shows every fourth of `LIGHT_TONES`, dithering between the two either side of its place, as the dark
 * theme's dots take one of three levels: the leaves keep the same grain in both themes.
 */
const LIGHT_GRAIN = 4;

/**
 * The shade a scene lays under the title row in `theme` and the season `color`, which the wordmark and sidebar button
 * go light on; else none.
 */
export const sceneTitleShade = (name: SceneName, theme: AppTheme, color: AppColor): Rgb | undefined =>
  theme === 'light' && SCENES[name].drawLight ? lightTonesByStep()[seasonSteps(color).shade]?.tones[12] : undefined;

/**
 * Draws scene `name` at `seconds` in the season `color`, a dot per CSS px, into `pixels` (RGBA packed little-endian,
 * as ImageData's buffer), `cols` × `rows`, using `value` and `drift` (the same size) as scratch. A spot without a dot is
 * left clear, so the sidebar shows through.
 */
export function drawScene(name: SceneName, pixels: Uint32Array, value: Float32Array, drift: Float32Array, cols: number, rows: number, seconds: number, theme: AppTheme, color: AppColor) {
  const scene = SCENES[name], strength = scene.strength ?? 1, ranks = ranksFor(cols * rows), season = seasonSteps(color);
  pixels.fill(0);
  if (theme === 'light' && scene.drawLight) {
    // `value` takes the places on the tones, `drift` is the scene's to work in.
    scene.drawLight(value, drift, cols, rows, seconds, ranks);
    const top = LIGHT_TONES.length - 1, byStep = lightTonesByStep();
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const cell = y * cols + x, place = Math.min(top, value[cell] ?? 0) / LIGHT_GRAIN, whole = Math.floor(place);
        const tone = (whole + (place - whole > (BAYER[(y & 7) * 8 + (x & 7)] ?? 0.5) ? 1 : 0)) * LIGHT_GRAIN;
        if (tone <= 0) continue;
        const rank = ranks[cell] ?? 0, turn = rank === SHADE ? season.shade : (season.steps[rankSlot(rank)] ?? 0);
        pixels[cell] = byStep[turn]?.pixels[tone] ?? 0;
      }
    }
    return;
  }
  sceneValues(name, value, drift, cols, rows, seconds, ranks);
  const byStep = scenePalettes(theme), ground = SCENE_PALETTE[theme].ground, dim = SCENE_DIM[theme] * strength;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const cell = y * cols + x, v = value[cell] ?? 0, level = v < 0.02 ? 0 : sceneLevel(v, x, y, theme);
      if (!level) continue;
      const palette = byStep[season.steps[rankSlot(ranks[cell] ?? 0)] ?? 0] ?? SCENE_PALETTE[theme];
      pixels[cell] = pack(sceneColor(palette, drift[cell] ?? 0, v), ground, level === 1 ? dim : strength);
    }
  }
}
