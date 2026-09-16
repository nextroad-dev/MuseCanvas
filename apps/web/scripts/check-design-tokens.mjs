#!/usr/bin/env node
/**
 * Design token guard.
 *
 * Design tokens live in exactly one place: `src/assets/index.css` (@theme).
 * Everything under `src` must consume them through Tailwind utilities or
 * `var(--token)`; Tailwind's default palette, raw black/white utilities and
 * hardcoded color literals are rejected so a token change propagates everywhere.
 *
 * Run standalone (`pnpm --filter @musecanvas/web lint:tokens`) or as part of
 * `pnpm lint`.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC_DIR = path.join(WEB_ROOT, 'src')
const TOKEN_FILE = 'src/assets/index.css'

/** Files allowed to contain literal colors: third-party brand marks. */
const ALLOWED_LITERAL_FILES = new Set(['src/shared/components/ui/GoogleIcon.vue'])

/** Color utility prefixes that must never fall back to Tailwind's default palette. */
const COLOR_PREFIXES = [
  'bg', 'text', 'border', 'ring', 'outline', 'from', 'to', 'via',
  'fill', 'stroke', 'divide', 'decoration', 'accent', 'caret',
  'placeholder', 'shadow', 'inset-shadow', 'divide-x', 'divide-y',
]
const PREFIX_GROUP = COLOR_PREFIXES.join('|')

const DEFAULT_PALETTE = [
  'slate', 'gray', 'zinc', 'neutral', 'stone',
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal',
  'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
]

/**
 * Lint rules for source files. Each rule is `{ id, description, pattern }` and is
 * matched line by line. Keep this table granular so new rules (for example a
 * `z-<number>` stacking-order rule) can be appended without restructuring.
 */
const SOURCE_RULES = [
  {
    id: 'no-default-palette',
    description: "use a design token instead of Tailwind's default palette",
    pattern: new RegExp(`\\b(?:${PREFIX_GROUP})-(?:${DEFAULT_PALETTE.join('|')})-\\d{2,3}\\b`, 'g'),
    allowLiteralFiles: true,
  },
  {
    id: 'no-black-white',
    description: 'use bg-overlay / text-foreground-inverse instead of raw black/white utilities',
    pattern: new RegExp(`\\b(?:${PREFIX_GROUP})-(?:black|white)(?:/\\d+)?\\b`, 'g'),
    allowLiteralFiles: true,
  },
  {
    id: 'no-color-literal',
    description: 'use a design token instead of a hex color literal',
    pattern: /#[0-9a-fA-F]{3,8}\b/g,
    allowLiteralFiles: true,
  },
  {
    id: 'no-color-literal',
    description: 'use a design token instead of a numeric rgb()/rgba() literal',
    pattern: /rgba?\(\s*\d/g,
    allowLiteralFiles: true,
  },
]

const violations = []

function report(file, line, rule, description, snippet) {
  violations.push({ file, line, rule, description, snippet: snippet.trim() })
}

function walk(dir, extensions) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      files.push(...walk(absolute, extensions))
    } else if (extensions.includes(path.extname(entry.name))) {
      files.push(absolute)
    }
  }
  return files
}

const toRelative = (absolute) => path.relative(WEB_ROOT, absolute).split(path.sep).join('/')

/* ------------------------------------------------------------------ *
 * Source rules: no default palette, no black/white, no color literals
 * ------------------------------------------------------------------ */

const sourceFiles = walk(SRC_DIR, ['.vue', '.ts'])

for (const absolute of sourceFiles) {
  const relative = toRelative(absolute)
  const lines = readFileSync(absolute, 'utf8').split(/\r?\n/)

  lines.forEach((line, index) => {
    for (const rule of SOURCE_RULES) {
      if (rule.allowLiteralFiles && ALLOWED_LITERAL_FILES.has(relative)) continue
      rule.pattern.lastIndex = 0
      if (rule.pattern.test(line)) {
        report(relative, index + 1, rule.id, rule.description, line)
      }
    }
  })
}

/* ------------------------------------------------------------------ *
 * Token rules: no dead color tokens, @theme only in the token file
 * ------------------------------------------------------------------ */

const TOKEN_DECLARATION_PATTERN = /--color-([a-z0-9-]+)\s*:/g
const tokenFileContents = readFileSync(path.join(WEB_ROOT, TOKEN_FILE), 'utf8')
const themeBlock = /@theme\s*\{([\s\S]*?)\n\}/.exec(tokenFileContents)
const declaredTokens = []

if (themeBlock) {
  TOKEN_DECLARATION_PATTERN.lastIndex = 0
  let match
  while ((match = TOKEN_DECLARATION_PATTERN.exec(themeBlock[1])) !== null) {
    declaredTokens.push(match[1])
  }
}

if (!themeBlock) {
  report(TOKEN_FILE, 1, 'theme-missing', `expected a @theme block in ${TOKEN_FILE}`, '')
}

// Consumers live outside the token file: either a Tailwind utility or var().
const consumerSources = sourceFiles
  .filter((absolute) => toRelative(absolute) !== TOKEN_FILE)
  .map((absolute) => readFileSync(absolute, 'utf8'))
  .join('\n')

for (const token of declaredTokens) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const utilityPattern = new RegExp(`(?:${PREFIX_GROUP})-${escaped}(?![a-z0-9-])`)
  const varPattern = new RegExp(`var\\(\\s*--color-${escaped}\\s*[,)]`)

  if (!utilityPattern.test(consumerSources) && !varPattern.test(consumerSources)) {
    report(TOKEN_FILE, 1, 'no-dead-token', `--color-${token} has no consumer; remove it or use it`, token)
  }
}

// @theme must stay in the single token file.
for (const absolute of walk(SRC_DIR, ['.vue', '.ts', '.css'])) {
  const relative = toRelative(absolute)
  if (relative === TOKEN_FILE) continue

  readFileSync(absolute, 'utf8')
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (/@theme\s*\{/.test(line)) {
        report(relative, index + 1, 'theme-single-source', '@theme may only be declared in src/assets/index.css', line)
      }
    })
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

if (violations.length === 0) {
  console.log(`design tokens: ok (${declaredTokens.length} color tokens, ${sourceFiles.length} source files checked)`)
  process.exit(0)
}

for (const violation of violations) {
  console.error(`${violation.file}:${violation.line}: [${violation.rule}] ${violation.description}`)
  if (violation.snippet) console.error(`    ${violation.snippet.slice(0, 200)}`)
}
console.error(`\ndesign tokens: ${violations.length} violation(s). See src/assets/index.css for the token set.`)
process.exit(1)