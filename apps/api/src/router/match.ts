import type { MatchedRoute, Route, RouteParams } from './types'

/**
 * Path pattern compilation.
 *
 * Every placeholder reproduces the character class of the `path.match()` it
 * replaces. That is on purpose: these widths are existing behaviour. Several
 * paths accept a loose lowercase id while the prompt-template and plugin ids
 * accept upper-case hex, and narrowing any of them would turn a working request
 * into a 404.
 */
const SEGMENT_PATTERNS: Record<string, string> = {
  // /^jobs\/([0-9a-f-]+)$/, /^library\/([0-9a-f-]+)\/download$/ and friends
  id: '[0-9a-f-]+',
  // /^admin\/prompt-templates\/sets\/([0-9a-fA-F-]+)$/ and the plugin id routes
  hexid: '[0-9a-fA-F-]+',
  // /^auth\/oauth\/(github|google)\/start$/ — the OAUTH_PROVIDERS whitelist
  oauth: 'github|google',
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g

function compile(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = []
  const source = pattern
    .split('/')
    .map(segment => {
      if (!segment.startsWith(':')) return segment.replace(ESCAPE, '\\$&')
      const name = segment.slice(1)
      const body = SEGMENT_PATTERNS[name]
      if (!body) throw new Error(`unknown route parameter :${name} in pattern "${pattern}"`)
      keys.push(name)
      return `(${body})`
    })
    .join('/')
  return { regex: new RegExp(`^${source}$`), keys }
}

const cache = new Map<string, { regex: RegExp; keys: string[] }>()

function compiled(pattern: string) {
  let entry = cache.get(pattern)
  if (!entry) {
    entry = compile(pattern)
    cache.set(pattern, entry)
  }
  return entry
}

export function matchPath(pattern: string, path: string): RouteParams | null {
  const { regex, keys } = compiled(pattern)
  const found = regex.exec(path)
  if (!found) return null
  const params: RouteParams = {}
  keys.forEach((key, index) => {
    params[key] = found[index + 1]
  })
  return params
}

/**
 * First match wins, so table order *is* precedence. The historical handler relied
 * on this in several places (`library` before `library/:id/download`,
 * `admin/prompt-templates` before `/sets` before `/export`), and `router.test.ts`
 * pins those orderings.
 */
export function matchRoute(routes: Route[], path: string): MatchedRoute | null {
  for (const route of routes) {
    const params = matchPath(route.path, path)
    if (params) return { route, params }
  }
  return null
}
