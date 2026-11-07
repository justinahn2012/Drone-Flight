// tools/expose.mjs — read-only reflection for the offline tools (node only).
// The game modules keep most of their data module-private (MATS, terrainHeight, GRADES...). Rather than adding
// exports to runtime files other streams own, the tools register a node load hook that appends one getter object,
// `__G_EXPOSED`, to the named modules as they load. Nothing on disk changes and the browser never sees it.
// A name that doesn't exist (renamed, removed) reads as undefined instead of failing, so callers fall back and warn.
//
//   const mods = await exposeAndImport(ROOT, { 'world-bando.js': ['MATS', 'terrainHeight'] });
//   mods['world-bando.js'].__G_EXPOSED.MATS
//
// Also: sourceLiteral(), which lifts a balanced {...} / (...) literal out of a source file (for constants that live
// inside functions or in browser-only files like main.js, which can't be imported in node).
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const HOOK = `
let T = {};
export async function initialize(d) { T = (d && d.targets) || {}; }
export async function load(url, ctx, next) {
  const names = T[url.split('?')[0]];
  const r = await next(url, ctx);
  if (!names) return r;
  let src = r.source;
  if (src == null) { const fs = await import('node:fs'); src = fs.readFileSync(new URL(url), 'utf8'); }
  if (typeof src !== 'string') src = new TextDecoder().decode(src);
  const body = names.map((n) => 'get ' + n + '() { return typeof ' + n + " === 'undefined' ? undefined : " + n + '; }').join(', ');
  return { format: 'module', source: src + '\\n;export const __G_EXPOSED = { ' + body + ' };\\n', shortCircuit: true };
}`;

let registered = false;
const targets = {};

/** Register the hook for `spec` = { 'file.js': [names] } (paths relative to root) and import those modules. */
export async function exposeAndImport(root, spec) {
  const urls = {};
  for (const [file, names] of Object.entries(spec)) {
    const url = pathToFileURL(resolve(root, file)).href;
    urls[file] = url;
    for (const n of names) if (!/^[A-Za-z_$][\w$]*$/.test(n)) throw new Error('expose: bad identifier ' + n);
    targets[url] = names;
  }
  if (registered) throw new Error('expose: register once per process (pass every module in one call)');
  register('data:text/javascript,' + encodeURIComponent(HOOK), { data: { targets } });
  registered = true;
  const out = {};
  for (const [file, url] of Object.entries(urls)) out[file] = await import(url);
  return out;
}

/**
 * Text of the balanced literal that starts at the first `open` char at/after `anchor` in `src`
 * (strings, template strings and comments skipped). Returns null when the anchor isn't found.
 */
export function sourceLiteral(src, anchor, open = '{', from = 0) {
  let at = -1;
  if (typeof anchor === 'string') at = src.indexOf(anchor, from);
  else { const k = src.slice(from).search(anchor); if (k >= 0) at = from + k; }
  if (at < 0) return null;
  const close = { '{': '}', '(': ')', '[': ']' }[open];
  let i = src.indexOf(open, at); if (i < 0) return null;
  const start = i; let depth = 0;
  for (; i < src.length; i++) {
    const j = skipNonCode(src, i); if (j >= 0) { i = j - 1; continue; }
    const ch = src[i];
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

/** Index just past the end of the string / comment starting at src[i], or -1 if src[i] doesn't start one. */
function skipNonCode(src, i) {
  const ch = src[i];
  if (ch === '"' || ch === "'" || ch === '`') { for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++; return i + 1; }
  if (ch === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); return j < 0 ? src.length : j; }
  if (ch === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); return j < 0 ? src.length : j + 2; }
  return -1;
}

/**
 * Top-level fields of an object literal's text ('{ a, b: expr, ... }'): -> { name: exprText } (shorthand a -> 'a').
 * Spread / computed / method entries are skipped.
 */
export function literalFields(text) {
  const out = {}; let depth = 0, start = 1;
  const flush = (end) => {
    const part = text.slice(start, end).trim(); start = end + 1;
    if (!part || part.startsWith('...')) return;
    const m = /^([A-Za-z_$][\w$]*)\s*(?::([\s\S]*))?$/.exec(part);
    if (m) out[m[1]] = m[2] === undefined ? m[1] : m[2].trim();
  };
  for (let i = 0; i < text.length; i++) {
    const j = skipNonCode(text, i); if (j >= 0) { i = j - 1; continue; }
    const ch = text[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') { depth--; if (depth === 0) { flush(i); break; } }
    else if (ch === ',' && depth === 1) flush(i);
  }
  return out;
}

/** Text of the body of `function name(...) {...}` in src (params skipped), or null. */
export function functionBody(src, name) {
  const at = src.search(new RegExp('function\\s+' + name + '\\s*\\('));
  if (at < 0) return null;
  const params = sourceLiteral(src, '(', '(', at); if (!params) return null;
  return sourceLiteral(src, '{', '{', src.indexOf(params, at) + params.length);
}

/** Evaluate a literal lifted by sourceLiteral with the given free variables in scope (our own repo source only). */
export function evalLiteral(text, scope = {}) {
  const keys = Object.keys(scope);
  return new Function(...keys, '"use strict"; return (' + text + ');')(...keys.map((k) => scope[k]));
}
