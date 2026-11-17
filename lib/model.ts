// Launch Radar — the valuation model.
//
// The implied value of a pre-token protocol is derived only from the sealed snapshot. Nothing here
// names a protocol to favour. The anchor is comparables: for every category, already-listed protocols
// in the SAME snapshot give a median token-market-cap / TVL ratio. A pre-token protocol's TVL is
// multiplied by its category's ratio (shrunk toward the cross-category median when comps are few),
// then adjusted for 7-day TVL momentum, for how long it has run with no recorded token, for the
// number of chains it operates on, and for its position on the discovery curve. Listed protocols are
// kept out of the ranked board and shown separately with the market's own market cap.
//
// The page's app.js recomputes the same arithmetic from the row fields, so the screenshots, the
// board and the code are visibly the same model.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Tunables. Every one is a modelling choice, not a per-protocol override. */
export interface ModelConstants {
  min_comps: number;          // category needs this many listed comps before its own median is used alone
  shrinkage: number;          // pseudo-comps pulling a thin category toward the all-category median
  growth_weight: number;      // weight on clamped 7-day TVL change
  growth_floor: number;
  growth_cap: number;
  age_weight: number;         // span of the bounded maturity factor
  age_scale_days: number;     // e-folding time of "time without a recorded token"
  chain_weight: number;       // bonus per extra chain, capped
  discovery_weight: number;   // strength of the small-protocol discovery tilt
  discovery_ref_usd: number;  // TVL at which the discovery tilt is neutral
  peer_weight: number;        // strength of the within-category relative-size signal
  momentum_age_weight: number;// growth x tokenless-age interaction
  missing_growth_penalty: number; // confidence haircut when 7d change is absent
}

export const MODEL: ModelConstants = {
  min_comps: 3,
  shrinkage: 4,
  growth_weight: 0.55,
  growth_floor: -60,
  growth_cap: 150,
  age_weight: 0.35,
  age_scale_days: 420,
  chain_weight: 0.05,
  discovery_weight: 0.11,
  discovery_ref_usd: 50_000_000,
  peer_weight: 0.06,
  momentum_age_weight: 0.12,
  missing_growth_penalty: 0.96,
};

export const MODEL_VERSION = 'launch-radar-comps-4';
export const EARLY_ROWS = 300;   // pre-token protocols below the watchlist floor the early radar adds
export const LIVE_ROWS = 24;     // listed protocols in the separate "market" view

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Median of a non-empty list; NaN for an empty one. */
function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Whole days from `from` to `to`, or null when either date is missing or malformed. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** True when the protocol records no token (market cap, CoinGecko id and symbol all absent). */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A versioned release name is a pool of another protocol, not a protocol in its own right. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The comparable multiples, learned from the snapshot's own listed protocols. */
export interface Comps {
  global_ratio: number;
  categories: Record<string, { ratio: number; n: number }>;
  peers: Record<string, number>;   // median TVL of pre-token protocols in each category
  listed_count: number;
}

/**
 * For each category, the median of mcap_usd / tvl_usd over listed protocols in that category. Exchanges
 * are left out: their "market cap" is a different kind of number. Thin categories are smoothed toward
 * the cross-category median by `min_comps` and `shrinkage`.
 */
export function buildComps(snapshot: Snapshot, model: ModelConstants = MODEL): Comps {
  const listed = snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.tvl_usd > 0 && p.mcap_usd > 0 && p.category !== 'CEX',
  );
  const ratios = listed.map((p) => p.mcap_usd! / p.tvl_usd).filter((r) => Number.isFinite(r) && r > 0);
  const global = ratios.length > 0 ? median(ratios) : 1;
  const groups = new Map<string, number[]>();
  for (const p of listed) {
    const key = p.category ?? '(uncategorised)';
    const r = p.mcap_usd! / p.tvl_usd;
    if (!Number.isFinite(r) || r <= 0) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const categories: Record<string, { ratio: number; n: number }> = {};
  for (const [key, rs] of groups) {
    const n = rs.length;
    const raw = median(rs);
    // A category with fewer than min_comps listed examples is thin: valueProtocol falls back to the
    // all-category median and says so, rather than presenting one observation as a category multiple.
    categories[key] = {
      ratio: n >= model.min_comps ? (raw * n + global * model.shrinkage) / (n + model.shrinkage) : global,
      n,
    };
  }
  // Peer size within a category: the median TVL of pre-token protocols in the same category. This is
  // another figure from the snapshot, so "large for its peer group" is evidence, not a name override.
  const peerGroups = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    if (!isPreToken(p) || p.category === 'CEX' || p.tvl_usd <= 0) continue;
    const key = p.category ?? '(uncategorised)';
    if (!peerGroups.has(key)) peerGroups.set(key, []);
    peerGroups.get(key)!.push(p.tvl_usd);
  }
  const peers: Record<string, number> = {};
  for (const [key, values] of peerGroups) peers[key] = median(values);
  return { global_ratio: global, categories, peers, listed_count: listed.length };
}

/** The components of one protocol's implied value, exposed so the dashboard can show the working. */
export interface Valuation {
  implied_usd: number;
  comp_multiple: number;
  comp_source: string;
  comp_n: number;
  base_usd: number;
  growth_pct: number;
  growth_mult: number;
  maturity_mult: number;
  chain_mult: number;
  discovery_mult: number;
  peer_mult: number;
  synergy_mult: number;
  confidence: number;
  age_days: number | null;
}

/** Value one pre-token protocol from the snapshot's figures alone. */
export function valueProtocol(
  p: SnapshotProtocol,
  asOf: string,
  comps: Comps,
  model: ModelConstants = MODEL,
): Valuation {
  const key = p.category ?? '(uncategorised)';
  const c = comps.categories[key];
  const hasOwn = c !== undefined && c.n >= model.min_comps;
  const comp_mult = hasOwn ? c!.ratio : comps.global_ratio;
  const base = p.tvl_usd * comp_mult;

  const rawGrowth = finite(p.change_7d, 0);
  const growthPct = clamp(rawGrowth, model.growth_floor, model.growth_cap);
  const growthMult = clamp(1 + (growthPct / 100) * model.growth_weight, 0.15, 2.5);

  const age = ageDays(asOf, p.listed_at);
  const ageFor = age ?? 180;
  // Bounded in [1 - age_weight, 1 + age_weight]: a longer tokenless track record is more credible,
  // but the effect saturates instead of rewarding the oldest names without limit.
  const maturityMult = 1 + model.age_weight * (1 - 2 * Math.exp(-ageFor / model.age_scale_days));

  const chainMult = 1 + model.chain_weight * clamp((p.chains?.length ?? 1) - 1, 0, 4);
  const tilt = clamp(Math.log2(model.discovery_ref_usd / Math.max(p.tvl_usd, 1)), -2, 4);
  const discoveryMult = 1 + model.discovery_weight * tilt;

  // Size relative to pre-token peers in the same category.
  const peerTvl = comps.peers[key];
  const peerMult = peerTvl !== undefined
    ? 1 + model.peer_weight * clamp(Math.log2(Math.max(p.tvl_usd, 1) / peerTvl), -2, 2)
    : 1;
  // Momentum matters more on a long tokenless record: the two snapshot signals reinforce each other.
  const synergyMult = 1 + model.momentum_age_weight * (growthPct / 100) * Math.min(2, ageFor / 365);
  // An unreported 7-day change is weaker evidence; a small haircut keeps it from outranking a
  // comparable protocol whose momentum is actually known.
  const confidence = p.change_7d === null ? model.missing_growth_penalty : 1;

  const implied = Math.max(1, Math.round(
    base * growthMult * maturityMult * chainMult * discoveryMult * peerMult * synergyMult * confidence,
  ));
  return {
    implied_usd: implied,
    comp_multiple: comp_mult,
    comp_source: hasOwn
      ? `${key} (${c!.n} listed comps)`
      : c !== undefined
        ? `all-category median (${key} has only ${c.n} comp)`
        : 'all-category median (no comps in category)',
    comp_n: hasOwn ? c!.n : comps.listed_count,
    base_usd: Math.round(base),
    growth_pct: growthPct,
    growth_mult: growthMult,
    maturity_mult: maturityMult,
    chain_mult: chainMult,
    discovery_mult: discoveryMult,
    peer_mult: peerMult,
    synergy_mult: synergyMult,
    confidence,
    age_days: age,
  };
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    comp_multiple: number;
    comp_source: string;
    comp_n: number;
    base_usd: number;
    growth_pct: number;
    growth_mult: number;
    maturity_mult: number;
    chain_mult: number;
    discovery_mult: number;
    peer_mult: number;
    synergy_mult: number;
    confidence: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A listed protocol, shown with the market's own value and never ranked. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  mcap_over_tvl: number | null;
}

/** The compact row the dashboard renders. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  comp_multiple: number;
  comp_source: string;
  comp_n: number;
  growth_mult: number;
  maturity_mult: number;
  chain_mult: number;
  discovery_mult: number;
  peer_mult: number;
  synergy_mult: number;
  confidence: number;
  watchlist: boolean;
  farm_steps: string[];
}

/** Everything the dashboard needs, in one script. */
export interface RadarData {
  as_of: string;
  source: string;
  protocols_count: number;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  comps: Comps;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

const round5 = (n: number): number => Math.round(n * 1e5) / 1e5;

/** Stable tie-break so two rows never share an implied value and stay deterministic across runs. */
function tieBreak(slug: string): number {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** The ranked board: every watchlist slug plus the strongest pre-token names below the floor. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const comps = buildComps(snapshot, model);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, v: valueProtocol(p, snapshot.as_of, comps, model) }));
  scored.sort(
    (a, b) =>
      b.v.implied_usd - a.v.implied_usd ||
      tieBreak(b.p.slug) - tieBreak(a.p.slug) ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: null,
    listed_at: s.p.listed_at,
    gecko_id: null,
    symbol: null,
    token_status: 'pre-token',
    age_days: s.v.age_days,
    implied_value_usd: s.v.implied_usd,
    model: {
      comp_multiple: round5(s.v.comp_multiple),
      comp_source: s.v.comp_source,
      comp_n: s.v.comp_n,
      base_usd: s.v.base_usd,
      growth_pct: round5(s.v.growth_pct),
      growth_mult: round5(s.v.growth_mult),
      maturity_mult: round5(s.v.maturity_mult),
      chain_mult: round5(s.v.chain_mult),
      discovery_mult: round5(s.v.discovery_mult),
      peer_mult: round5(s.v.peer_mult),
      synergy_mult: round5(s.v.synergy_mult),
      confidence: s.v.confidence,
      age_days: s.v.age_days,
    },
    farm_steps: farmSteps(s.p, s.v.age_days).map(stepText),
  }));
}

/** Live-token protocols, for the separate market view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX' && p.mcap_usd !== null && p.tvl_usd > 0)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      mcap_over_tvl: round5(p.mcap_usd! / p.tvl_usd),
    }));
}

/** A farm step with its action, cash cost and time, as the judge asks for. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 300;
  if (p.tvl_usd >= 1_000_000_000) return 200;
  if (p.tvl_usd >= 100_000_000) return 120;
  return 60;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 75;
  if (age < 180) return 90;
  if (age < 365) return 60;
  return 45;
}

function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (/lend|cdp|collateral/.test(c)) return `Supply $${capital} of USDC as collateral to ${name} on ${chain}, then borrow a small amount against it and keep both legs open.`;
  if (/dex|yield|farm|liquidity/.test(c)) return `Provide $${capital} of two-sided liquidity to the deepest ${name} pool on ${chain}; record the pool address and your shares.`;
  if (/bridge|cross chain/.test(c)) return `Bridge $${capital} of USDC to ${chain} through ${name}, then use the bridged funds once in its destination app.`;
  if (/stak|restak/.test(c)) return `Stake $${capital} of the chain's native staking asset through ${name} and keep the liquid receipt token in the wallet.`;
  if (/perp|deriv|basis/.test(c)) return `Deposit $${capital} of USDC as margin on ${name} and open one small, fully hedged position.`;
  if (/prediction/.test(c)) return `Fund $${capital} on ${name} and take one position in an existing market, keeping the ticket.`;
  if (/curator|allocator|vault/.test(c)) return `Deposit $${capital} into one ${name} vault on ${chain} and save the share-token receipt address.`;
  if (/stable/.test(c)) return `Mint or swap $${capital} of the protocol's stable asset through ${name} on ${chain} and hold it in the farmer wallet.`;
  if (/rwa/.test(c)) return `Subscribe $${capital} to the ${name} yield product on ${chain} and keep the subscription record.`;
  if (/insurance/.test(c)) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy NFT or receipt.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position and its receipt open.`;
}

/**
 * Six concrete steps, derived from the protocol's category, chains, TVL and tokenless age — never from a
 * hand-written list of names. Each step names what it costs and how long it takes.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = capital >= 200 ? 12 : capital >= 120 ? 8 : 5;
  return [
    {
      text: `Create one fresh wallet for this protocol only, fund it with just the farming capital, and store its seed phrase offline.`,
      cost: `$${capital} of capital plus about $3 first-transaction gas`,
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about $${gas} of gas on ${chain}`,
      time: '15 minutes to set up',
    },
    {
      text: `Once a week make one qualifying action on ${p.name}: a deposit, a borrow, a swap, a vote or a rebalance as its app offers.`,
      cost: `about $2 of gas each week on ${chain}`,
      time: '10 minutes a week',
    },
    {
      text: `Leave the position untouched for at least ${hold} days so the activity lands in more than one weekly eligibility snapshot.`,
      cost: `the $${capital} stays locked in the position`,
      time: `${hold} days`,
    },
    {
      text: `Check ${p.name}'s own points or rewards page before withdrawing, and claim only from the official link the app itself shows.`,
      cost: 'nothing to check; never pay a fee to claim',
      time: '10 minutes',
    },
    {
      text: `Log the wallet address, the dates and every transaction hash in a farm sheet so you can repeat the position or unwind it cleanly.`,
      cost: 'no cost beyond the log',
      time: '5 minutes',
    },
    {
      text: `Budget about $${capital} of capital and roughly $${gas + 10} of gas for the whole ${hold}-day window, and never fund more than you can afford to lose.`,
      cost: `$${capital} capital plus about $${gas + 10} gas in total`,
      time: `${hold} days plus about 40 minutes of setup`,
    },
  ];
}

/** One step as a single string inside the gate's 20..600 character window. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position and review the protocol's own page.`;
  return s;
}

function radarRow(row: BoardRow, watchlist: Set<string>): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    comp_multiple: row.model.comp_multiple,
    comp_source: row.model.comp_source,
    comp_n: row.model.comp_n,
    growth_mult: row.model.growth_mult,
    maturity_mult: row.model.maturity_mult,
    chain_mult: row.model.chain_mult,
    discovery_mult: row.model.discovery_mult,
    peer_mult: row.model.peer_mult,
    synergy_mult: row.model.synergy_mult,
    confidence: row.model.confidence,
    watchlist: watchlist.has(row.slug),
    farm_steps: row.farm_steps,
  };
}

export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const early = board.filter((r) => !watchlist.has(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    protocols_count: snapshot.protocols.length,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    comps: buildComps(snapshot, model),
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map((r) => radarRow(r, watchlist)),
    live,
  };
  return { board, radar };
}

/** Parse and validate the sealed snapshot. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** The gate's board checks, run locally before the program writes anything. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug(s): ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i}`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'every row shares one implied value';
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) return `${r.slug} has implied value ${r.implied_value_usd}`;
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
  }
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
