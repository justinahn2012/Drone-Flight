// ci/bundle-size.mjs [P6 H, native bug "re-check <= 60 MB deflated"]: the Seoul export's size as an app bundle ships it.
// An .ipa is a zip, so each file is deflated on its own: the gate is the sum of per-file deflate (level 6) <= MAX MB.
//   node ci/bundle-size.mjs exports/seoul-hongdae [--max 60]
// Prints the raw and deflated totals and the five largest files; exit 1 past the budget.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const a = process.argv.slice(2), dir = a.find((x) => !x.startsWith('--')) || 'exports/seoul-hongdae';
const MAX = +(a[a.indexOf('--max') + 1] || 0) || 60;
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const rows = walk(dir).map((p) => { const b = readFileSync(p); return { f: relative(dir, p), raw: b.length, def: deflateRawSync(b, { level: 6 }).length }; });
const MB = (n) => (n / 1048576).toFixed(1), raw = rows.reduce((s, r) => s + r.raw, 0), def = rows.reduce((s, r) => s + r.def, 0);
console.log(`bundle ${dir}: ${rows.length} files, raw ${MB(raw)} MB, deflated per file ${MB(def)} MB (budget ${MAX} MB)`);
for (const r of rows.sort((x, y) => y.def - x.def).slice(0, 5)) console.log(`  ${r.f.padEnd(28)} raw ${MB(r.raw).padStart(6)} MB  deflated ${MB(r.def).padStart(6)} MB`);
const ok = def <= MAX * 1048576;
console.log(`${ok ? 'ok  ' : 'FAIL'} the Seoul bundle deflates to ${MB(def)} MB <= ${MAX} MB`);
process.exit(ok ? 0 : 1);
