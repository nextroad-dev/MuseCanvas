#!/usr/bin/env node
/**
 * Design-token guard for apps/web.
 *
 * The app has one token source (`src/app/globals.css`) and a design system that
 * says which value belongs to which job. Nothing enforced that until now: there is
 * no ESLint or Stylelint in this workspace, so a raw hex or a token typo would only
 * ever be caught by a human noticing a colour is slightly off.
 *
 * This script fails on the four regressions that are cheap to detect and expensive
 * to notice, and reports one that needs a human:
 *
 *   A. `var(--x)` referencing a token `globals.css` never defines (typo / dead ref)
 *   B. raw colour literals in TS/TSX (`#rrggbb`, `rgb()`, `hsl()`)
 *   C. a bare numeric transition duration (`duration-150`) — off-scale motion
 *   D. `h-[var(--icon-x)] w-[var(--icon-x)]` pairs, which the `iconSize` /
 *      `controlSquare` maps exist to replace
 *   E. tokens defined but referenced by neither `var()` nor a plausible generated
 *      utility — advisory only, because a `--color-*` can be consumed as
 *      `text-*`/`bg-*`/`hover:`/`dark:` and that cannot be decided reliably
 *   F. arbitrary font sizes (`text-[11px]`) in TS/TSX, which bypass the type scale
 *      (use `text-caption` for 11px, or a `--text-*` token)
 *   G. `rounded-full` in TS/TSX outside the circular-primitive allowlist
 *
 * F and G are WARN-only while the migration is in flight. Set their entry in
 * `SEVERITY` to `'fail'` to turn them into hard failures.
 *
 * Usage: `node scripts/check-web-tokens.mjs [--root <dir>]`
 * Exit code 0 = clean (advisory findings may still print), 1 = at least one failure.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')

const rootArgIndex = process.argv.indexOf('--root')
const WEB_ROOT = rootArgIndex === -1
  ? path.join(REPO_ROOT, 'apps', 'web', 'src')
  : path.resolve(process.argv[rootArgIndex + 1])

const GLOBALS_CSS = path.join(WEB_ROOT, 'app', 'globals.css')

/**
 * Files allowed to contain raw colour literals. `brand-icons` draws the Google
 * sign-in mark, whose colours are fixed by Google's brand guidelines and must NOT
 * be remapped onto our palette — that is the one legitimate exception.
 */
const ALLOW_RAW_COLOUR = ['brand-icons.tsx']

/**
 * `var()` reads that are supplied at runtime rather than by the theme. `reveal.tsx`
 * writes `--stagger-index` inline, and `globals.css` reads it with a fallback.
 */
const ALLOW_UNDEFINED_VAR = ['--stagger-index']

/**
 * Token prefixes that Tailwind turns into utilities, so `var()` is not the only consumer.
 * Ordered longest-first so `--z-index-` is stripped before `--z-`.
 */
const UTILITY_NAMESPACE = [
  '--inset-shadow-', '--drop-shadow-', '--z-index-', '--breakpoint-', '--container-',
  '--leading-', '--tracking-', '--spacing-', '--animate-', '--aspect-',
  '--shadow-', '--radius-', '--color-', '--text-', '--font-', '--ease-', '--blur-',
]

/** Namespaces whose consumer is a Tailwind *variant* prefix rather than a class name. */
const VARIANT_NAMESPACE = ['--breakpoint-']

/**
 * Tokens consumed by Tailwind's own machinery rather than by a class in our source.
 * These override Tailwind's built-in defaults, so no `var()` and no utility name
 * exists to find — see the comment above them in `globals.css`.
 */
const ALLOW_UNUSED = [
  '--default-transition-duration',
  '--default-transition-timing-function',
]

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.css'])

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.next') walk(full, out)
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full)
    }
  }
  return out
}

/**
 * Strip comments so prose *about* a token can never trip a check. The size maps in
 * `size.ts` document the very pattern check D forbids, and a naive scan would fail
 * on the documentation for the fix.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

/**
 * Severity per rule. A, B, C and D always fail. F and G start as `'warn'`: they are
 * printed but do not change the exit code, so files still being migrated do not
 * block CI. Flip an entry to `'fail'` once the codebase is clean for that rule.
 */
const SEVERITY = { F: 'warn', G: 'warn' }

const failures = []
const warnings = []
const advisories = []

function report(rule, file, line, detail) {
  failures.push(`${rule}  ${path.relative(REPO_ROOT, file)}:${line}  ${detail}`)
}

/** Rule-aware reporter: fails or warns according to `SEVERITY`. */
function reportRule(rule, file, line, detail) {
  const entry = `${rule}  ${path.relative(REPO_ROOT, file)}:${line}  ${detail}`
  if (SEVERITY[rule] === 'fail') failures.push(entry)
  else warnings.push(entry)
}

// ---------------------------------------------------------------- read the tokens

const css = fs.readFileSync(GLOBALS_CSS, 'utf8')
const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))

const allFiles = walk(WEB_ROOT)
// `globals.css` is the token source: it legitimately contains raw colour literals and
// it is therefore excluded from checks B–D, but INCLUDED when deciding whether a
// token is consumed, because the `@layer utilities` / keyframe rules there are real
// consumers (`.is-disabled { opacity: var(--opacity-disabled) }`).
const checkFiles = allFiles.filter((f) => f !== GLOBALS_CSS)
const readAll = allFiles.map((file) => {
  const raw = fs.readFileSync(file, 'utf8')
  return { file, raw, clean: stripComments(raw) }
})
const sources = readAll.filter((s) => s.file !== GLOBALS_CSS)

// ---------------------------------------------------- A. undefined token references

for (const { file, clean } of sources) {
  for (const match of clean.matchAll(/var\(\s*(--[a-z0-9-]+)\s*[,)]/g)) {
    const token = match[1]
    if (defined.has(token) || ALLOW_UNDEFINED_VAR.includes(token)) continue
    report('A', file, lineOf(clean, match.index), `var(${token}) is not defined in globals.css`)
  }
}

// ------------------------------------------------------------ B. raw colour literals

const COLOUR_PATTERNS = [
  { re: /#[0-9a-fA-F]{3,8}\b/g, label: 'hex colour' },
  { re: /\b(?:rgb|rgba|hsl|hsla)\s*\(/g, label: 'functional colour' },
]

for (const { file, clean } of sources) {
  if (ALLOW_RAW_COLOUR.some((allowed) => file.endsWith(allowed))) continue
  for (const { re, label } of COLOUR_PATTERNS) {
    for (const match of clean.matchAll(re)) {
      report('B', file, lineOf(clean, match.index), `${label} ${match[0]} — use a token utility instead`)
    }
  }
}

// ------------------------------------------ C. off-scale transition duration/easing

// `duration-[var(--motion-*)]` is fine (an explicit token); `duration-150` is not.
const BARE_DURATION = /\bduration-(\d+)\b/g
// Project easings are `--ease-*`; Tailwind's `ease-linear` and `ease-none` have no
// token counterpart and are reported, while `ease-in/out/in-out` are numerically
// identical to the tokens and stay allowed.
const OFF_SCALE_EASING = /\bease-(linear|initial|inherit)\b/g

for (const { file, clean } of sources) {
  for (const match of clean.matchAll(BARE_DURATION)) {
    report('C', file, lineOf(clean, match.index), `duration-${match[1]} bypasses --motion-* (use \`transition-*\`, which is token-timed by default)`)
  }
  for (const match of clean.matchAll(OFF_SCALE_EASING)) {
    report('C', file, lineOf(clean, match.index), `ease-${match[1]} has no token counterpart (--ease-*)`)
  }
}

// ------------------------------------------------- D. hand-written icon/control size pairs

const SIZE_PAIR = /h-\[var\((--(?:icon|control)-[a-z0-9]+)\)\]\s+w-\[var\(\1\)\]/g
const SVG_SIZE_PAIR = /\[&>svg\]:h-\[var\((--(?:icon|control)-[a-z0-9]+)\)\]\s+\[&>svg\]:w-\[var\(\1\)\]/g

for (const { file, clean } of sources) {
  for (const re of [SIZE_PAIR, SVG_SIZE_PAIR]) {
    for (const match of clean.matchAll(re)) {
      report('D', file, lineOf(clean, match.index), `${match[0]} — use \`iconSize\`/\`iconSlot\`/\`controlSquare\` from shared/components/ui`)
    }
  }
}

// ------------------------------------- F. arbitrary font size (warn, see SEVERITY)

/**
 * `text-[11px]` sits outside the type scale. The 11px metadata size is
 * `text-caption`; any other size should be a `--text-*` token.
 */
const ARBITRARY_FONT_SIZE = /\btext-\[(\d+(?:\.\d+)?)px\]/g

for (const { file, clean } of sources) {
  if (!/\.tsx?$/.test(file)) continue
  for (const match of clean.matchAll(ARBITRARY_FONT_SIZE)) {
    const fix = Number(match[1]) === 11 ? 'use `text-caption`' : 'use a `--text-*` token'
    reportRule('F', file, lineOf(clean, match.index), `${match[0]} bypasses the type scale — ${fix}`)
  }
}

// ----------------------------- G. rounded-full outside the primitives (warn, see SEVERITY)

/**
 * `rounded-full` is for circular primitives. Everything else takes a shape from the
 * radius scale (`rounded-control`, `rounded-card`, `rounded-panel`) or `rounded-pill`.
 * Matched by file stem, so `radio.tsx` covers the whole radio primitive.
 */
const ROUNDED_FULL = /\brounded-full\b/g
const ROUNDED_FULL_ALLOW = ['badge', 'checkbox', 'radio', 'skeleton', 'spinner', 'avatar']

for (const { file, clean } of sources) {
  if (!/\.tsx?$/.test(file)) continue
  const stem = path.basename(file).replace(/\.tsx?$/, '')
  if (ROUNDED_FULL_ALLOW.includes(stem)) continue
  for (const match of clean.matchAll(ROUNDED_FULL)) {
    reportRule('G', file, lineOf(clean, match.index), 'rounded-full outside the circular-primitive allowlist — use `rounded-pill` for a pill, or a radius token')
  }
}

// ------------------------------------------- E. tokens with no discoverable consumer

const allClean = readAll.map((s) => s.clean).join('\n')
const varConsumed = new Set([...allClean.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]))

/**
 * "Consumed" for a namespaced token also means one of its generated utility classes
 * appears somewhere — `--color-tonal` counts as used when `bg-tonal` /
 * `hover:text-tonal` is present. Only the namespace names that the caller could not
 * otherwise see need this treatment, and a breakpoint is consumed as a variant
 * prefix (`md:`), never as a class.
 */
function utilityName(token) {
  for (const ns of UTILITY_NAMESPACE) {
    if (token.startsWith(ns)) return { name: token.slice(ns.length), namespace: ns }
  }
  return null
}

function hasGeneratedUtility(token) {
  const mapped = utilityName(token)
  if (!mapped) return false
  const { name, namespace } = mapped

  if (VARIANT_NAMESPACE.includes(namespace)) {
    // A breakpoint is consumed as a variant prefix: `md:`, `max-md:`, `md-max:`.
    return new RegExp(`(^|[\\s"'\`\\[({])([a-z-]*:)?${name}(-max)?:`, 'm').test(allClean)
  }

  const variants = ['', 'hover:', 'focus:', 'focus-visible:', 'active:', 'disabled:', 'aria-[invalid=true]:', 'dark:', 'group-hover:', 'group-focus-within:', 'sm:', 'md:', 'lg:', 'xl:']
  const fns = ['bg', 'text', 'border', 'divide', 'ring', 'fill', 'stroke', 'outline', 'from', 'to', 'via', 'accent', 'caret', 'decoration', 'placeholder']
  const direct = ['rounded', 'shadow', 'max-w', 'min-w', 'w', 'h', 'min-h', 'max-h', 'z', 'ease', 'animate', 'font', 'blur', 'aspect', 'leading', 'tracking', 'size']

  for (const v of variants) {
    for (const fn of fns) if (allClean.includes(`${v}${fn}-${name}`)) return true
    for (const fn of direct) if (allClean.includes(`${v}${fn}-${name}`)) return true
    // `--text-*` doubles as a font size (`text-module`), covered above by `text`.
  }
  return false
}

for (const token of [...defined].sort()) {
  if (varConsumed.has(token)) continue
  if (ALLOW_UNUSED.includes(token)) continue
  // Companions that always ride their base token.
  if (token.endsWith('--line-height') || token.endsWith('--letter-spacing') || token.endsWith('--font-weight')) continue
  if (hasGeneratedUtility(token)) continue
  if (utilityName(token)) {
    advisories.push(`${token}  declared but no \`var()\` or matching utility reference was found`)
  } else {
    advisories.push(`${token}  declared but never referenced by \`var()\``)
  }
}

// ------------------------------------------------------------------------- report

const rel = (label, list) => {
  if (list.length === 0) return
  console.log(`\n${label} (${list.length})`)
  for (const line of list) console.log('  ' + line)
}

console.log(`token check — ${checkFiles.length} source files (+globals.css) against ${defined.size} tokens`)

const ruleTitles = {
  A: 'A · undefined token reference',
  B: 'B · raw colour literal',
  C: 'C · off-scale transition value',
  D: 'D · hand-written size pair',
  F: 'F · arbitrary font size (warning)',
  G: 'G · rounded-full outside the primitives (warning)',
}
const allFindings = [...failures, ...warnings]
for (const rule of ['A', 'B', 'C', 'D', 'F', 'G']) {
  const hits = allFindings.filter((f) => f.startsWith(rule + '  '))
  rel(ruleTitles[rule], hits.map((h) => h.replace(/^[A-G]\s+/, '')))
}

rel('E · unused token (advisory, not a failure)', advisories.map((a) => a.replace(/\s+/g, ' ')))

if (failures.length > 0) {
  console.log(`\nFAIL: ${failures.length} violation(s).`)
  process.exit(1)
}
console.log('\nPASS: no undefined tokens, raw colours, off-scale motion or hand-written size pairs.')
if (warnings.length > 0) console.log(`${warnings.length} warning(s) under F/G — advisory until SEVERITY is set to 'fail'.`)
if (advisories.length > 0) console.log(`${advisories.length} token(s) reported as unused — review, then delete or document.`)
