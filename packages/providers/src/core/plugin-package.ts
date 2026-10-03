import { Inflate, zipSync } from 'fflate'
import {
  PLUGIN_ARTIFACT_MAX_BYTES,
  scanPluginSource,
  validatePluginManifest,
  type AnyProviderManifest,
  type PluginScanFinding,
} from './plugin-scan'

/*
 * Zip plugin packages (MuseCanvas-Connector wiki/plugin-package-spec.md, §2–§4).
 *
 * A package is one .zip carrying `manifest.json` (the plugin manifest plus a
 * `package` block), exactly one entry `.mjs` bundle and optional docs/icon. The
 * security model is unchanged from the single-.mjs upload: zero runtime imports,
 * the same source scan, the same manifest validation. The zip adds an attack
 * surface of its own (path traversal, symlinks, bombs, ambiguous layouts), and
 * all of it is refused here, in the API process, before a byte is stored. The
 * worker never parses a zip: it keeps loading the entry bundle by its own key.
 *
 * Pure and deterministic like plugin-scan.ts: no node builtins, no I/O, no clock.
 * The central directory is read by hand (fflate's unzip API does not expose
 * external attributes, encryption flags or zip64 markers, which are exactly the
 * things to refuse), and fflate is used only as a streaming DEFLATE decoder so
 * every entry is inflated in memory under a hard byte budget. Hashing (node:crypto)
 * and the full icon decode (sharp) are the host's job, see plugin-package-icon.ts.
 */

/** Zip file itself, checked before any entry is read. */
export const PLUGIN_PACKAGE_MAX_BYTES = 6 * 1024 * 1024
/** Sum of every entry's uncompressed size. */
export const PLUGIN_PACKAGE_MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024
/** Central directory records, directories included. */
export const PLUGIN_PACKAGE_MAX_ENTRIES = 32
/** manifest.json and each README / CHANGELOG / LICENSE style document. */
export const PLUGIN_PACKAGE_TEXT_MAX_BYTES = 256 * 1024
export const PLUGIN_PACKAGE_ICON_MAX_BYTES = 256 * 1024
export const PLUGIN_PACKAGE_ICON_MAX_EDGE = 512
/** Per entry, uncompressed : compressed. */
export const PLUGIN_PACKAGE_MAX_COMPRESSION_RATIO = 100
/** UTF-8 bytes of an entry name as stored in the zip. */
export const PLUGIN_PACKAGE_MAX_PATH_BYTES = 200
/** The only `package.format` this host understands. */
export const PLUGIN_PACKAGE_FORMAT = 1
export const PLUGIN_PACKAGE_MANIFEST_PATH = 'manifest.json'

export const PLUGIN_PACKAGE_ERROR_CODES = [
  'PLUGIN_PACKAGE_TOO_LARGE',
  'PLUGIN_PACKAGE_INVALID',
  'PLUGIN_PACKAGE_UNSAFE_PATH',
  'PLUGIN_PACKAGE_FORBIDDEN_FILE',
  'PLUGIN_PACKAGE_ENTRY_MISSING',
  'PLUGIN_PACKAGE_BOMB',
] as const
export type PluginPackageErrorCode = (typeof PLUGIN_PACKAGE_ERROR_CODES)[number]

/** plugin-packages/<pluginId>/<version>/<sha256>.zip — the original upload, archive only. */
export function pluginPackageObjectKey(pluginId: string, version: string, sha256: string): string {
  return `plugin-packages/${pluginId}/${version}/${sha256}.zip`
}

/** plugin-packages/<pluginId>/<version>/icon-<sha256>.<ext> — served to the admin console. */
export function pluginIconObjectKey(pluginId: string, version: string, sha256: string, extension: PluginPackageIconExtension): string {
  return `plugin-packages/${pluginId}/${version}/icon-${sha256}.${extension}`
}

export type PluginPackageIconExtension = 'png' | 'webp'
export type PluginPackageIconMimeType = 'image/png' | 'image/webp'

/** One central directory record. `read()` inflates and verifies the entry's bytes. */
export type PluginZipEntry = {
  /** Raw entry name, decoded as UTF-8 (U+FFFD where the bytes were not UTF-8). */
  name: string
  /** False when the raw name bytes were not valid UTF-8. */
  nameIsUtf8: boolean
  nameByteLength: number
  isDirectory: boolean
  /** 0 = stored, 8 = deflate; anything else is refused while reading the directory. */
  method: number
  compressedSize: number
  uncompressedSize: number
  /** High byte is the host system (3 = Unix, 19 = OS X). */
  versionMadeBy: number
  externalAttributes: number
  /** Throws PluginPackageError. Never returns more than `uncompressedSize` bytes. */
  read(): Uint8Array
}

export class PluginPackageError extends Error {
  readonly code: PluginPackageErrorCode
  readonly path?: string
  constructor(code: PluginPackageErrorCode, message: string, path?: string) {
    super(message)
    this.name = code
    this.code = code
    if (path !== undefined) this.path = path
  }
}

/** Author-supplied display fields of the `package` block. */
export type PluginPackageMeta = {
  author?: string
  license?: string
  homepage?: string
}

export type PluginPackageFile = { path: string; sizeBytes: number; bytes: Uint8Array }

export type InspectedPluginPackage = {
  /** validatePluginManifest(manifest.json without `package`). */
  manifest: AnyProviderManifest
  meta: PluginPackageMeta
  entry: { path: string; bytes: Uint8Array; source: string }
  icon: {
    path: string
    bytes: Uint8Array
    mimeType: PluginPackageIconMimeType
    extension: PluginPackageIconExtension
    width: number
    height: number
  } | null
  readme: { path: string; text: string } | null
  changelog: { path: string; text: string } | null
  license: { path: string; text: string } | null
  /** Every file after the wrapping directory is stripped, sorted by path. */
  files: PluginPackageFile[]
  /** The single wrapping directory that was stripped, if any. */
  strippedRoot: string | null
}

export type PluginPackageInspection =
  | { ok: true; package: InspectedPluginPackage; findings: PluginScanFinding[]; warnings: PluginScanFinding[] }
  | { ok: false; code: string; findings: PluginScanFinding[] }

/**
 * Packs files into a zip-v1 package (deflate, fixed timestamps so the same input
 * always yields the same bytes and therefore the same package digest). Does not
 * validate: run inspectPluginPackage on the result. Used by tests and intended
 * for author-side tooling (spec §8); the host never calls it on upload.
 */
export function createPluginPackageZip(files: Record<string, Uint8Array>): Uint8Array {
  const entries: Record<string, [Uint8Array, { mtime: Date; level: 6 }]> = {}
  const mtime = new Date(Date.UTC(2020, 0, 1))
  for (const [path, bytes] of Object.entries(files)) entries[path] = [bytes, { mtime, level: 6 }]
  return zipSync(entries)
}

// ---------------------------------------------------------------------------
// Step 1–2: size precheck and central directory
// ---------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const EOCD_SIZE = 22
const FLAG_ENCRYPTED = 0x0001
const FLAG_DATA_DESCRIPTOR = 0x0008
const FLAG_STRONG_ENCRYPTION = 0x0040
const FLAG_MASKED_HEADERS = 0x2000
const METHOD_STORED = 0
const METHOD_DEFLATE = 8
const METHOD_AES = 99
const EXTRA_ZIP64 = 0x0001
/** DEFLATE input per push: bounds the output a single push can materialize (~1032x). */
const INFLATE_CHUNK_BYTES = 4096

const utf8Strict = new TextDecoder('utf-8', { fatal: true })
const utf8Lenient = new TextDecoder('utf-8')

/**
 * Parses the end-of-central-directory record and every central directory entry,
 * cross-checking each against its local header. Refuses encryption, zip64,
 * multi-volume archives, unsupported compression methods, overlapping entries
 * and directory/local-header disagreement. No entry data is inflated here.
 */
export function readPluginZipDirectory(bytes: Uint8Array): PluginZipEntry[] {
  const invalid = (message: string, path?: string) => new PluginPackageError('PLUGIN_PACKAGE_INVALID', message, path)
  if (bytes.byteLength > PLUGIN_PACKAGE_MAX_BYTES) {
    throw new PluginPackageError('PLUGIN_PACKAGE_TOO_LARGE', `package exceeds ${PLUGIN_PACKAGE_MAX_BYTES} bytes`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const length = bytes.byteLength
  const eocd = findEndOfCentralDirectory(view, length)
  if (eocd < 0) throw invalid('not a zip archive (no end-of-central-directory record)')

  const diskNumber = view.getUint16(eocd + 4, true)
  const directoryDisk = view.getUint16(eocd + 6, true)
  const entriesOnDisk = view.getUint16(eocd + 8, true)
  const totalEntries = view.getUint16(eocd + 10, true)
  const directorySize = view.getUint32(eocd + 12, true)
  const directoryOffset = view.getUint32(eocd + 16, true)

  if ((eocd >= 20 && view.getUint32(eocd - 20, true) === SIG_ZIP64_LOCATOR)
    || totalEntries === 0xffff || entriesOnDisk === 0xffff
    || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw invalid('zip64 archives are not supported')
  }
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw invalid('multi-volume archives are not supported')
  }
  if (totalEntries === 0) throw invalid('the archive is empty')
  if (totalEntries > PLUGIN_PACKAGE_MAX_ENTRIES) {
    throw new PluginPackageError('PLUGIN_PACKAGE_TOO_LARGE', `package has ${totalEntries} entries; at most ${PLUGIN_PACKAGE_MAX_ENTRIES} are allowed`)
  }
  if (directoryOffset + directorySize > eocd) throw invalid('central directory overlaps the end record')

  const entries: PluginZipEntry[] = []
  const ranges: Array<{ start: number; end: number; name: string }> = []
  let cursor = directoryOffset
  for (let index = 0; index < totalEntries; index++) {
    if (cursor + 46 > directoryOffset + directorySize || view.getUint32(cursor, true) !== SIG_CENTRAL) {
      throw invalid('central directory is truncated or corrupt')
    }
    const versionMadeBy = view.getUint16(cursor + 4, true)
    const flags = view.getUint16(cursor + 8, true)
    const method = view.getUint16(cursor + 10, true)
    const crc = view.getUint32(cursor + 16, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const uncompressedSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const startDisk = view.getUint16(cursor + 34, true)
    const externalAttributes = view.getUint32(cursor + 38, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength
    if (recordEnd > directoryOffset + directorySize) throw invalid('central directory is truncated or corrupt')

    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    const decodedName = decodeName(nameBytes)
    const label = decodedName.name

    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_MASKED_HEADERS) || method === METHOD_AES) {
      throw invalid('encrypted entries are not supported', label)
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw invalid(`compression method ${method} is not supported; use stored or deflate`, label)
    }
    if (startDisk !== 0) throw invalid('multi-volume archives are not supported', label)
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff
      || hasExtraField(view, cursor + 46 + nameLength, extraLength, EXTRA_ZIP64)) {
      throw invalid('zip64 entries are not supported', label)
    }

    // Local header must agree with the directory: a reader that trusts one and an
    // extractor that trusts the other is the classic way to smuggle a second file.
    if (localOffset + 30 > directoryOffset || view.getUint32(localOffset, true) !== SIG_LOCAL) {
      throw invalid('local header is missing or corrupt', label)
    }
    const localFlags = view.getUint16(localOffset + 6, true)
    const localMethod = view.getUint16(localOffset + 8, true)
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    if ((localFlags & FLAG_ENCRYPTED) !== (flags & FLAG_ENCRYPTED) || localMethod !== method) {
      throw invalid('local header disagrees with the central directory', label)
    }
    if (localNameLength !== nameLength || !sameBytes(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength), nameBytes)) {
      throw invalid('local header name disagrees with the central directory', label)
    }
    if (!(localFlags & FLAG_DATA_DESCRIPTOR)) {
      const localCrc = view.getUint32(localOffset + 14, true)
      const localCompressed = view.getUint32(localOffset + 18, true)
      const localUncompressed = view.getUint32(localOffset + 22, true)
      if (localCompressed === 0xffffffff || localUncompressed === 0xffffffff) throw invalid('zip64 entries are not supported', label)
      if (localCrc !== crc || localCompressed !== compressedSize || localUncompressed !== uncompressedSize) {
        throw invalid('local header sizes disagree with the central directory', label)
      }
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > directoryOffset) throw invalid('entry data runs into the central directory', label)
    ranges.push({ start: localOffset, end: dataEnd, name: label })

    const isDirectory = label.endsWith('/')
    if (isDirectory && uncompressedSize !== 0) throw invalid('directory entries must be empty', label)
    if (method === METHOD_STORED && compressedSize !== uncompressedSize) throw invalid('stored entry sizes disagree', label)

    const data = bytes.subarray(dataStart, dataEnd)
    entries.push({
      name: label,
      nameIsUtf8: decodedName.valid,
      nameByteLength: nameLength,
      isDirectory,
      method,
      compressedSize,
      uncompressedSize,
      versionMadeBy,
      externalAttributes,
      read: () => inflateEntry(data, method, uncompressedSize, crc, label),
    })
    cursor = recordEnd
  }
  if (cursor !== directoryOffset + directorySize) throw invalid('central directory size disagrees with its records')

  // Overlapping entries (several directory records pointing into one compressed
  // stream) are a known bomb construction; a real archiver never writes them.
  ranges.sort((a, b) => a.start - b.start)
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index].start < ranges[index - 1].end) throw invalid('entries overlap', ranges[index].name)
  }
  return entries
}

function findEndOfCentralDirectory(view: DataView, length: number): number {
  const floor = Math.max(0, length - EOCD_SIZE - 0xffff)
  for (let offset = length - EOCD_SIZE; offset >= floor; offset--) {
    if (view.getUint32(offset, true) !== SIG_EOCD) continue
    // The comment must end exactly at the end of the file: trailing bytes are
    // ambiguous (and a signature inside a comment is not the real record).
    if (offset + EOCD_SIZE + view.getUint16(offset + 20, true) === length) return offset
  }
  return -1
}

function hasExtraField(view: DataView, start: number, length: number, headerId: number): boolean {
  let offset = start
  const end = start + length
  while (offset + 4 <= end) {
    const id = view.getUint16(offset, true)
    const size = view.getUint16(offset + 2, true)
    if (id === headerId) return true
    offset += 4 + size
  }
  return false
}

function decodeName(nameBytes: Uint8Array): { name: string; valid: boolean } {
  try {
    return { name: utf8Strict.decode(nameBytes), valid: true }
  } catch {
    return { name: utf8Lenient.decode(nameBytes), valid: false }
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false
  return true
}

/**
 * Inflates one entry in memory, never past its declared size: the declared size
 * already passed the ratio and total checks, so the actual stream is held to it
 * rather than trusted. A stream that yields more is a bomb; fewer bytes or a CRC
 * mismatch is a corrupt (or deliberately inconsistent) archive.
 */
function inflateEntry(data: Uint8Array, method: number, expectedSize: number, expectedCrc: number, path: string): Uint8Array {
  let output: Uint8Array
  if (method === METHOD_STORED) {
    output = data.slice()
  } else {
    output = new Uint8Array(expectedSize)
    let written = 0
    let overflow = false
    const inflater = new Inflate((chunk) => {
      if (overflow) return
      if (written + chunk.length > expectedSize) {
        overflow = true
        return
      }
      output.set(chunk, written)
      written += chunk.length
    })
    try {
      for (let offset = 0; offset < data.length && !overflow; offset += INFLATE_CHUNK_BYTES) {
        const end = Math.min(offset + INFLATE_CHUNK_BYTES, data.length)
        inflater.push(data.subarray(offset, end), end === data.length)
      }
      if (data.length === 0) inflater.push(new Uint8Array(0), true)
    } catch {
      throw new PluginPackageError('PLUGIN_PACKAGE_INVALID', 'entry data is not valid deflate', path)
    }
    if (overflow) {
      throw new PluginPackageError('PLUGIN_PACKAGE_BOMB', 'entry inflates past its declared size', path)
    }
    if (written !== expectedSize) {
      throw new PluginPackageError('PLUGIN_PACKAGE_INVALID', 'entry inflates to fewer bytes than declared', path)
    }
  }
  if (crc32(output) !== expectedCrc) {
    throw new PluginPackageError('PLUGIN_PACKAGE_INVALID', 'entry CRC-32 does not match', path)
  }
  return output
}

let crcTable: Uint32Array | null = null

/** CRC-32 (IEEE 802.3), as stored in zip headers. */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index++) crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// Steps 3–7: paths, inventory, manifest, entry, resources
// ---------------------------------------------------------------------------

type FileClass = 'manifest' | 'code' | 'doc' | 'icon'

const UNIX_HOSTS = new Set([3, 19])
const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000
const PACKAGE_BLOCK_KEYS = new Set(['format', 'entry', 'icon', 'readme', 'license', 'author', 'homepage'])
const META_TEXT_MAX = 200
const LICENSE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+\-() ]{0,99}$/

/** Reads and validates a zip package in one call: §4 steps 1–7. */
export function inspectPluginPackage(bytes: Uint8Array): PluginPackageInspection {
  let entries: PluginZipEntry[]
  try {
    entries = readPluginZipDirectory(bytes)
  } catch (error) {
    return rejectFromError(error)
  }
  return validatePluginPackageEntries(entries)
}

/**
 * §4 steps 3–7 over already-parsed directory entries. Each step's findings are
 * collected in full (so the admin sees every bad path at once), and the first
 * step that produced an error stops the walk: later steps would only report
 * consequences of the earlier problem.
 */
export function validatePluginPackageEntries(entries: PluginZipEntry[]): PluginPackageInspection {
  // --- step 3: path safety ---------------------------------------------------
  const pathFindings: PluginScanFinding[] = []
  const unsafe = (path: string, message: string) =>
    pathFindings.push(packageFinding('PLUGIN_PACKAGE_UNSAFE_PATH', message, path))
  const seen = new Map<string, string>()
  for (const entry of entries) {
    const problem = unsafePathReason(entry)
    if (problem) {
      unsafe(entry.name, problem)
      continue
    }
    const key = foldPath(entry.name)
    const clash = seen.get(key)
    if (clash !== undefined) unsafe(entry.name, `collides with '${clash}' after Unicode/case folding`)
    else seen.set(key, entry.name)
  }
  if (!pathFindings.length) {
    // A file whose folded path is also a directory prefix would be overwritten by
    // (or overwrite) that directory on extraction.
    const fileKeys = entries.filter(entry => !entry.isDirectory).map(entry => foldPath(entry.name))
    for (const entry of entries) {
      const key = foldPath(entry.name)
      const parent = fileKeys.find(fileKey => key.startsWith(`${fileKey}/`))
      if (parent) unsafe(entry.name, `is nested under '${parent}', which is a file`)
    }
  }
  if (pathFindings.length) return reject(pathFindings)

  // --- macOS archiver metadata: dropped silently ------------------------------
  // Finder's "Compress" adds __MACOSX/ (AppleDouble forks) and .DS_Store. They
  // still passed path safety above and still count toward the entry cap (in
  // readPluginZipDirectory) and the uncompressed total (below), but they are
  // never inflated, never listed, and do not count as a second top-level root.
  const ignored = entries.filter(entry => isIgnoredPackagePath(entry.name))
  const kept = entries.filter(entry => !isIgnoredPackagePath(entry.name))
  const ignoredBytes = ignored.reduce((sum, entry) => sum + (entry.isDirectory ? 0 : entry.uncompressedSize), 0)

  // --- layout: one optional wrapping directory --------------------------------
  const layout = resolveLayout(kept)
  if (!layout.ok) return reject([packageFinding('PLUGIN_PACKAGE_INVALID', layout.message)])
  const files = kept
    .filter(entry => !entry.isDirectory)
    .map(entry => ({ entry, path: entry.name.slice(layout.prefix.length) }))

  // --- step 4: inventory (declared sizes, before anything is inflated) ---------
  const inventory: PluginScanFinding[] = []
  const classes = new Map<string, FileClass>()
  let declaredTotal = ignoredBytes
  for (const { entry, path } of files) {
    declaredTotal += entry.uncompressedSize
    const fileClass = classifyPath(path)
    if (!fileClass) {
      inventory.push(packageFinding('PLUGIN_PACKAGE_FORBIDDEN_FILE', forbiddenMessage(path), path))
      continue
    }
    classes.set(path, fileClass)
    const cap = fileClass === 'code' ? PLUGIN_ARTIFACT_MAX_BYTES
      : fileClass === 'icon' ? PLUGIN_PACKAGE_ICON_MAX_BYTES
        : PLUGIN_PACKAGE_TEXT_MAX_BYTES
    if (entry.uncompressedSize > cap) {
      inventory.push(packageFinding('PLUGIN_PACKAGE_TOO_LARGE', `${entry.uncompressedSize} bytes exceeds the ${cap}-byte cap for this file type`, path))
    }
    if (entry.uncompressedSize > PLUGIN_PACKAGE_MAX_COMPRESSION_RATIO * Math.max(entry.compressedSize, 1)) {
      inventory.push(packageFinding('PLUGIN_PACKAGE_BOMB', `compression ratio exceeds ${PLUGIN_PACKAGE_MAX_COMPRESSION_RATIO}:1`, path))
    }
  }
  if (declaredTotal > PLUGIN_PACKAGE_MAX_UNCOMPRESSED_BYTES) {
    inventory.push(packageFinding('PLUGIN_PACKAGE_TOO_LARGE', `package unpacks to ${declaredTotal} bytes; at most ${PLUGIN_PACKAGE_MAX_UNCOMPRESSED_BYTES} are allowed`))
  }
  const codePaths = [...classes].filter(([, fileClass]) => fileClass === 'code').map(([path]) => path)
  if (codePaths.length > 1) {
    for (const path of codePaths) {
      inventory.push(packageFinding('PLUGIN_PACKAGE_FORBIDDEN_FILE', 'a package carries exactly one .mjs bundle; bundle dependencies into the entry', path))
    }
  }
  const iconPaths = [...classes].filter(([, fileClass]) => fileClass === 'icon').map(([path]) => path)
  if (iconPaths.length > 1) {
    for (const path of iconPaths) inventory.push(packageFinding('PLUGIN_PACKAGE_FORBIDDEN_FILE', 'a package carries at most one icon', path))
  }
  if (!classes.has(PLUGIN_PACKAGE_MANIFEST_PATH)) {
    inventory.push(packageFinding('PLUGIN_PACKAGE_INVALID', 'manifest.json is missing from the package root'))
  }
  if (inventory.length) return reject(inventory)

  // Inflate everything once; the inventory guarantees the total stays bounded.
  const contents = new Map<string, Uint8Array>()
  try {
    for (const { entry, path } of files) contents.set(path, entry.read())
  } catch (error) {
    return rejectFromError(error, layout.prefix)
  }

  // --- step 5: manifest.json and its `package` block -------------------------
  const manifestBytes = contents.get(PLUGIN_PACKAGE_MANIFEST_PATH) as Uint8Array
  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(utf8Strict.decode(manifestBytes)))
  } catch {
    return {
      ok: false,
      code: 'INVALID_PLUGIN_MANIFEST',
      findings: [{ rule: 'INVALID_MANIFEST_JSON', severity: 'error', message: 'manifest.json is not valid UTF-8 JSON', path: PLUGIN_PACKAGE_MANIFEST_PATH }],
    }
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      code: 'INVALID_PLUGIN_MANIFEST',
      findings: [{ rule: 'INVALID_MANIFEST_JSON', severity: 'error', message: 'manifest.json must hold a JSON object', path: PLUGIN_PACKAGE_MANIFEST_PATH }],
    }
  }
  const { package: packageBlock, ...manifestInput } = parsed
  const block = parsePackageBlock(packageBlock, classes)
  if (!block.ok) return { ok: false, code: block.code, findings: block.findings }

  // --- steps 5–6: plugin manifest and entry scan, reported together ----------
  const entryBytes = contents.get(block.entry) as Uint8Array
  const entrySource = utf8Lenient.decode(entryBytes)
  const validated = validatePluginManifest(manifestInput)
  const scanFindings = scanPluginSource(entrySource).map(finding => ({ ...finding, path: block.entry }))
  const manifestFindings = validated.ok ? [] : validated.findings.map(finding => ({ ...finding, path: PLUGIN_PACKAGE_MANIFEST_PATH }))
  const findings = [...scanFindings, ...manifestFindings]
  if (!validated.ok || findings.some(finding => finding.severity === 'error')) {
    return { ok: false, code: 'PLUGIN_SCAN_FAILED', findings }
  }

  // --- step 7: resources ------------------------------------------------------
  const resourceFindings: PluginScanFinding[] = []
  let icon: InspectedPluginPackage['icon'] = null
  for (const path of iconPaths) {
    if (path !== block.icon) {
      resourceFindings.push(packageFinding('PLUGIN_PACKAGE_FORBIDDEN_FILE', 'icon file is not referenced by package.icon', path))
    }
  }
  if (block.icon) {
    const iconBytes = contents.get(block.icon) as Uint8Array
    const header = inspectIconHeader(iconBytes)
    const extension = block.icon.toLowerCase().endsWith('.png') ? 'png' : 'webp'
    if (!header) {
      resourceFindings.push(packageFinding('PLUGIN_PACKAGE_INVALID', 'icon is not a complete PNG or WebP image', block.icon))
    } else if (header.extension !== extension) {
      resourceFindings.push(packageFinding('PLUGIN_PACKAGE_INVALID', `icon content is ${header.extension} but the file is named .${extension}`, block.icon))
    } else if (header.animated) {
      resourceFindings.push(packageFinding('PLUGIN_PACKAGE_INVALID', 'animated icons are not supported', block.icon))
    } else if (header.width < 1 || header.height < 1 || header.width > PLUGIN_PACKAGE_ICON_MAX_EDGE || header.height > PLUGIN_PACKAGE_ICON_MAX_EDGE) {
      resourceFindings.push(packageFinding('PLUGIN_PACKAGE_TOO_LARGE', `icon is ${header.width}x${header.height}; each edge must be 1..${PLUGIN_PACKAGE_ICON_MAX_EDGE} px`, block.icon))
    } else {
      icon = { path: block.icon, bytes: iconBytes, mimeType: header.mimeType, extension: header.extension, width: header.width, height: header.height }
    }
  }
  const texts = new Map<string, string>()
  for (const [path, fileClass] of classes) {
    if (fileClass !== 'doc') continue
    const text = decodeDocument(contents.get(path) as Uint8Array)
    if (text === null) {
      resourceFindings.push(packageFinding('PLUGIN_PACKAGE_INVALID', 'document must be UTF-8 text without NUL characters', path))
    } else {
      texts.set(path, text)
    }
  }
  if (resourceFindings.length) return reject(resourceFindings)

  const rootDoc = (pattern: RegExp) => {
    const path = [...texts.keys()].sort().find(candidate => !candidate.includes('/') && pattern.test(candidate))
    return path === undefined ? null : { path, text: texts.get(path) as string }
  }
  const readme = block.readme ? { path: block.readme, text: texts.get(block.readme) as string } : rootDoc(/^readme\.md$/i)

  const warnings = findings.filter(finding => finding.severity === 'warn')
  return {
    ok: true,
    findings,
    warnings,
    package: {
      manifest: validated.manifest,
      meta: block.meta,
      entry: { path: block.entry, bytes: entryBytes, source: entrySource },
      icon,
      readme,
      changelog: rootDoc(/^changelog\.(md|txt)$/i),
      license: rootDoc(/^license(\.md|\.txt)?$/i),
      files: files
        .map(({ path }) => ({ path, sizeBytes: (contents.get(path) as Uint8Array).byteLength, bytes: contents.get(path) as Uint8Array }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      strippedRoot: layout.prefix ? layout.prefix.slice(0, -1) : null,
    },
  }
}

function packageFinding(code: string, message: string, path?: string): PluginScanFinding {
  return { rule: code, severity: 'error', message, ...(path !== undefined ? { path } : {}) }
}

function reject(findings: PluginScanFinding[]): PluginPackageInspection {
  return { ok: false, code: findings[0].rule, findings }
}

function rejectFromError(error: unknown, prefix = ''): PluginPackageInspection {
  if (error instanceof PluginPackageError) {
    const path = error.path !== undefined && prefix && error.path.startsWith(prefix) ? error.path.slice(prefix.length) : error.path
    return reject([packageFinding(error.code, error.message, path)])
  }
  return reject([packageFinding('PLUGIN_PACKAGE_INVALID', 'the package could not be read')])
}

function unsafePathReason(entry: PluginZipEntry): string | null {
  const name = entry.name
  if (!entry.nameIsUtf8) return 'entry name is not valid UTF-8'
  if (entry.nameByteLength > PLUGIN_PACKAGE_MAX_PATH_BYTES) return `path is longer than ${PLUGIN_PACKAGE_MAX_PATH_BYTES} bytes`
  if (!name) return 'empty entry name'
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'path contains NUL or control characters'
  if (name.includes('\\')) return 'path contains a backslash'
  if (name.startsWith('/')) return 'absolute paths are not allowed'
  if (name.includes(':')) return 'drive letters and colons are not allowed'
  const segments = (entry.isDirectory ? name.slice(0, -1) : name).split('/')
  for (const segment of segments) {
    if (segment === '') return 'path contains an empty segment'
    if (segment === '.' || segment === '..') return "'.' and '..' segments are not allowed"
  }
  if (UNIX_HOSTS.has(entry.versionMadeBy >>> 8)) {
    const type = (entry.externalAttributes >>> 16) & S_IFMT
    if (type === S_IFLNK) return 'symbolic links are not allowed'
    const expected = entry.isDirectory ? S_IFDIR : S_IFREG
    if (type !== 0 && type !== expected) return 'device files, sockets and other special entries are not allowed'
  }
  return null
}

/** NFC + lowercase, without the trailing slash of a directory record. */
function foldPath(name: string): string {
  return name.replace(/\/$/, '').normalize('NFC').toLowerCase()
}

/**
 * macOS archiver metadata the host drops without a finding: anything under a
 * `__MACOSX` directory (at any depth, so also inside a wrapping directory) and
 * any `.DS_Store` file. Exact, case-sensitive names, as Finder writes them.
 */
export function isIgnoredPackagePath(name: string): boolean {
  const segments = name.replace(/\/$/, '').split('/')
  return segments.includes('__MACOSX') || segments[segments.length - 1] === '.DS_Store'
}

function resolveLayout(entries: PluginZipEntry[]): { ok: true; prefix: string } | { ok: false; message: string } {
  const files = entries.filter(entry => !entry.isDirectory)
  if (!files.length) return { ok: false, message: 'the package contains no files' }
  if (files.some(entry => entry.name === PLUGIN_PACKAGE_MANIFEST_PATH)) return { ok: true, prefix: '' }
  const roots = new Set(entries.map(entry => entry.name.split('/')[0]))
  const [root] = [...roots]
  const prefix = `${root}/`
  if (roots.size === 1 && files.every(entry => entry.name.startsWith(prefix))
    && files.some(entry => entry.name === `${prefix}${PLUGIN_PACKAGE_MANIFEST_PATH}`)) {
    return { ok: true, prefix }
  }
  return {
    ok: false,
    message: 'manifest.json must sit at the package root or inside exactly one top-level directory that holds every other file',
  }
}

function classifyPath(path: string): FileClass | null {
  if (path === PLUGIN_PACKAGE_MANIFEST_PATH) return 'manifest'
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const extension = dot > 0 ? base.slice(dot).toLowerCase() : ''
  if (extension === '.mjs') return 'code'
  if (extension === '.md' || extension === '.txt' || base === 'LICENSE') return 'doc'
  if (extension === '.png' || extension === '.webp') return 'icon'
  return null
}

function forbiddenMessage(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.svg')) return 'SVG is not allowed: it can carry script and the console renders icons directly; use .png or .webp'
  if (lower.endsWith('.json')) return 'manifest.json at the package root is the only JSON file allowed; inline data into the bundle'
  if (/\.(js|cjs|wasm|node)$/.test(lower)) return 'only the single .mjs entry may carry code'
  return 'file type is not allowed in a plugin package (allowed: manifest.json, one .mjs, .md/.txt/LICENSE, one .png/.webp icon)'
}

type PackageBlockResult =
  | { ok: true; entry: string; icon: string | null; readme: string | null; meta: PluginPackageMeta }
  | { ok: false; code: string; findings: PluginScanFinding[] }

function parsePackageBlock(value: unknown, classes: Map<string, FileClass>): PackageBlockResult {
  const findings: Array<{ code: string; finding: PluginScanFinding }> = []
  const fail = (code: string, message: string) =>
    findings.push({ code, finding: { rule: code, severity: 'error', message, path: PLUGIN_PACKAGE_MANIFEST_PATH } })
  const invalid = (message: string) => fail('PLUGIN_PACKAGE_INVALID', message)
  if (!isRecord(value)) {
    fail('PLUGIN_PACKAGE_ENTRY_MISSING', 'manifest.json must carry a `package` object with `format` and `entry`')
    return { ok: false, code: 'PLUGIN_PACKAGE_ENTRY_MISSING', findings: findings.map(item => item.finding) }
  }
  for (const key of Object.keys(value)) {
    if (!PACKAGE_BLOCK_KEYS.has(key)) invalid(`package.${key} is not a recognised field`)
  }
  if (value.format !== PLUGIN_PACKAGE_FORMAT) invalid(`package.format must be ${PLUGIN_PACKAGE_FORMAT}; this host does not understand ${JSON.stringify(value.format ?? null)}`)

  const entry = typeof value.entry === 'string' ? value.entry : ''
  if (!entry) {
    fail('PLUGIN_PACKAGE_ENTRY_MISSING', 'package.entry is required')
  } else if (!entry.endsWith('.mjs')) {
    fail('PLUGIN_PACKAGE_ENTRY_MISSING', 'package.entry must name a .mjs file')
  } else if (classes.get(entry) !== 'code') {
    fail('PLUGIN_PACKAGE_ENTRY_MISSING', `package.entry '${entry}' does not exist in the package`)
  }

  let icon: string | null = null
  if (value.icon !== undefined) {
    const raw = typeof value.icon === 'string' ? value.icon : ''
    const lower = raw.toLowerCase()
    if (lower.endsWith('.svg')) fail('PLUGIN_PACKAGE_FORBIDDEN_FILE', 'package.icon may not be SVG; use .png or .webp')
    else if (!lower.endsWith('.png') && !lower.endsWith('.webp')) invalid('package.icon must name a .png or .webp file')
    else if (classes.get(raw) !== 'icon') invalid(`package.icon '${raw}' does not exist in the package`)
    else icon = raw
  }

  let readme: string | null = null
  if (value.readme !== undefined) {
    const raw = typeof value.readme === 'string' ? value.readme : ''
    if (classes.get(raw) !== 'doc') invalid('package.readme must name a .md or .txt file in the package')
    else readme = raw
  }

  const meta: PluginPackageMeta = {}
  if (value.license !== undefined) {
    if (typeof value.license !== 'string' || !LICENSE_PATTERN.test(value.license.trim())) invalid('package.license must be an SPDX license expression')
    else meta.license = value.license.trim()
  }
  if (value.author !== undefined) {
    const author = typeof value.author === 'string' ? value.author.trim() : ''
    if (!author || author.length > META_TEXT_MAX) invalid(`package.author must be a non-empty string of at most ${META_TEXT_MAX} characters`)
    else meta.author = author
  }
  if (value.homepage !== undefined) {
    const homepage = typeof value.homepage === 'string' ? value.homepage.trim() : ''
    if (!isHttpsUrl(homepage)) invalid('package.homepage must be an https URL')
    else meta.homepage = homepage
  }

  if (findings.length) {
    const entryProblem = findings.find(item => item.code === 'PLUGIN_PACKAGE_ENTRY_MISSING')
    return { ok: false, code: (entryProblem ?? findings[0]).code, findings: findings.map(item => item.finding) }
  }
  return { ok: true, entry, icon, readme, meta }
}

function isHttpsUrl(value: string): boolean {
  if (!value || value.length > 2048) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password
  } catch {
    return false
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Strict UTF-8, BOM stripped. NUL is refused: Postgres `text` cannot store it. */
function decodeDocument(bytes: Uint8Array): string | null {
  try {
    const text = stripBom(utf8Strict.decode(bytes))
    return text.includes('\u0000') ? null : text
  } catch {
    return null
  }
}

export type PluginIconHeader = {
  mimeType: PluginPackageIconMimeType
  extension: PluginPackageIconExtension
  width: number
  height: number
  animated: boolean
}

// Fixed 12-byte IEND trailer every complete PNG ends with.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PNG_IEND_TAIL = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]

/**
 * Structural PNG / WebP header parse: container signature, dimensions, animation
 * and completeness. The host follows up with a full decode (plugin-package-icon.ts);
 * this pure pass is what keeps a bogus or oversized icon from ever reaching it.
 */
export function inspectIconHeader(bytes: Uint8Array): PluginIconHeader | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const startsWith = (signature: number[], offset = 0) =>
    bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte)
  if (startsWith(PNG_SIGNATURE)) {
    if (bytes.length < 33 + 12 || view.getUint32(8) !== 13 || !startsWith([0x49, 0x48, 0x44, 0x52], 12)) return null
    if (!startsWith(PNG_IEND_TAIL, bytes.length - PNG_IEND_TAIL.length)) return null
    // An acTL chunk before IDAT makes it an APNG.
    const animated = findPngChunk(bytes, view, 'acTL')
    return { mimeType: 'image/png', extension: 'png', width: view.getUint32(16), height: view.getUint32(20), animated }
  }
  const ascii = (offset: number, text: string) => startsWith([...text].map(char => char.charCodeAt(0)), offset)
  if (bytes.length >= 30 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    if (view.getUint32(4, true) + 8 !== bytes.length) return null
    if (ascii(12, 'VP8 ')) {
      // Lossy: 3-byte frame tag, start code 9d 01 2a, then 14-bit width/height.
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null
      return { mimeType: 'image/webp', extension: 'webp', width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff, animated: false }
    }
    if (ascii(12, 'VP8L')) {
      if (bytes[20] !== 0x2f) return null
      const bits = view.getUint32(21, true)
      return { mimeType: 'image/webp', extension: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, animated: false }
    }
    if (ascii(12, 'VP8X')) {
      const flags = bytes[20]
      const width = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1
      const height = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1
      return { mimeType: 'image/webp', extension: 'webp', width, height, animated: (flags & 0x02) !== 0 }
    }
  }
  return null
}

function findPngChunk(bytes: Uint8Array, view: DataView, type: string): boolean {
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset)
    const chunkType = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    if (chunkType === type) return true
    if (chunkType === 'IDAT' || chunkType === 'IEND') return false
    offset += 12 + length
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
