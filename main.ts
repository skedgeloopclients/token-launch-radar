// Launch Radar — entry point (Node 22, standard library only, no network, deterministic).
//
// Reads the sealed snapshot, values every pre-token protocol with the comparables model in lib/model.ts,
// writes the ranked board, the dashboard's data script, a copy of the static dashboard and its three
// screenshots, and finally the dossier the judge reads. The scorer runs this twice and compares bytes:
// every figure comes from the snapshot and from fixed constants, so both runs agree.
//
// Outside the grader: MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`launch radar: no snapshot at ${inputFile}: pass --input <snapshot.json|dir> or mount /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`launch radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy a directory's regular files, skipping dot-names, into `to`. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied.sort();
}

const dashboardFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
// The dossier shows every dashboard source file whole while the text fits in 64 KiB. Refuse a page
// that would be cut: the judge must read the whole model and renderer, not the first half of them.
const sourceBytes = dashboardFiles.reduce((n, f) => n + statSync(join(out, 'dashboard', f)).size, 0);
if (sourceBytes > TEXT_MAX_BYTES) {
  process.stderr.write(`launch radar: dashboard source is ${sourceBytes} bytes, over the ${TEXT_MAX_BYTES} the dossier shows whole\n`);
  process.exit(1);
}
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`launch radar: screenshots/ holds ${shots.length}: hand in the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`launch radar: screenshots/${name}: a name is letters, digits and . _ -\n`);
    process.exit(1);
  }
}

// Written last: the scorer rebuilds the dossier from this /output and compares bytes.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: TEXT_MAX_BYTES,
    screenshots: SCREENSHOT_CAPS,
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  }),
);

process.stdout.write(
  `launch radar: ${snapshot.protocols.length} protocols, ${radar.comps.listed_count} listed comps, ${board.length} rows scored ` +
    `(${radar.early_size} early, ${radar.live_size} in the market view)\n` +
    `launch radar: wrote board.json, data.js, dashboard/ (3 files), screenshots/ (${shots.length}) and dossier.json to ${out}\n`,
);
