// Single-range HTTP byte ranges (RFC 9110 section 14). Video playback needs `206` seeks.
//
// - No header, a non-`bytes` unit, or several ranges: serve the whole object (the
//   server may ignore Range; multi-range is not supported).
// - One malformed or unsatisfiable `bytes=` range: `unsatisfiable` (416).

export type ByteRangeResult =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' }

const SINGLE_RANGE = /^(\d*)-(\d*)$/

export function parseByteRange(header: string | null | undefined, size: number): ByteRangeResult {
  if (!header) return { kind: 'full' }
  const trimmed = header.trim()
  if (!/^bytes=/i.test(trimmed)) return { kind: 'full' }
  const spec = trimmed.slice('bytes='.length)
  if (spec.includes(',')) return { kind: 'full' }
  const match = SINGLE_RANGE.exec(spec.trim())
  if (!match) return { kind: 'unsatisfiable' }
  const [, startText, endText] = match
  if (startText === '' && endText === '') return { kind: 'unsatisfiable' }

  if (size <= 0) return { kind: 'unsatisfiable' }
  if (startText === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(endText)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: 'unsatisfiable' }
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(startText)
  if (!Number.isSafeInteger(start) || start >= size) return { kind: 'unsatisfiable' }
  if (endText === '') return { kind: 'partial', start, end: size - 1 }
  const end = Number(endText)
  if (!Number.isSafeInteger(end) || end < start) return { kind: 'unsatisfiable' }
  return { kind: 'partial', start, end: Math.min(end, size - 1) }
}
