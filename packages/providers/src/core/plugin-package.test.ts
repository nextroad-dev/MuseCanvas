import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { zipSync, type Zippable } from 'fflate'
import {
  PLUGIN_PACKAGE_MAX_BYTES,
  PLUGIN_PACKAGE_MAX_ENTRIES,
  crc32,
  createPluginPackageZip,
  decodePluginPackageIcon,
  inspectIconHeader,
  inspectPluginPackage,
  isIgnoredPackagePath,
  pluginIconObjectKey,
  pluginObjectKey,
  pluginPackageObjectKey,
  validatePluginManifest,
  validatePluginPackageEntries,
  type PluginPackageInspection,
  type PluginZipEntry,
} from './index'

const encoder = new TextEncoder()
const text = (value: string) => encoder.encode(value)

const MANIFEST = {
  kind: 'media',
  id: 'acme-video',
  version: '1.2.0',
  displayName: 'Acme Video',
  modalities: ['video'],
  allowedHosts: ['api.acme.example'],
  credentialSchemas: ['legacy-api-key-v1'],
  models: [{ id: 'acme-v2', modalities: ['video'] }],
}

const PACKAGE_BLOCK = {
  format: 1,
  entry: 'plugin.mjs',
  license: 'MIT',
  author: 'Acme Inc.',
  homepage: 'https://acme.example/musecanvas',
}

const BUNDLE = `const manifest = ${JSON.stringify(MANIFEST)}
export default {
  manifest,
  validateConfig() {},
  validateRequest() {},
  async submit() { return { status: 'succeeded', outputs: [] } },
}
`

function manifestJson(packageBlock: unknown = PACKAGE_BLOCK, overrides: Record<string, unknown> = {}): Uint8Array {
  return text(JSON.stringify({ ...MANIFEST, ...overrides, package: packageBlock }, null, 2))
}

/** A valid flat package; each test overrides the files it is about. */
function files(extra: Zippable = {}): Zippable {
  return {
    'manifest.json': manifestJson(),
    'plugin.mjs': text(BUNDLE),
    'README.md': text('# Acme Video\n\nRenders video.\n'),
    'CHANGELOG.md': text('## 1.2.0\n- first\n'),
    LICENSE: text('MIT License\n'),
    ...extra,
  }
}

const pack = (contents: Zippable) => zipSync(contents, { level: 6 })

function expectReject(result: PluginPackageInspection, code: string, path?: string): void {
  assert.equal(result.ok, false, `expected ${code}, got ok`)
  if (result.ok) return
  assert.equal(result.code, code, JSON.stringify(result.findings))
  if (path !== undefined) {
    assert.ok(result.findings.some(finding => finding.path === path), `no finding for ${path}: ${JSON.stringify(result.findings)}`)
  }
}

/** Locates a central directory record and its local header by entry name. */
function locate(zip: Uint8Array, name: string): { central: number; local: number } {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  for (let offset = 0; offset + 46 <= zip.length; offset++) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue
    const nameLength = view.getUint16(offset + 28, true)
    if (new TextDecoder().decode(zip.subarray(offset + 46, offset + 46 + nameLength)) === name) {
      return { central: offset, local: view.getUint32(offset + 42, true) }
    }
  }
  throw new Error(`no central record for ${name}`)
}

async function pngIcon(size: number): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width: size, height: size, channels: 4, background: '#ff5500' } }).png().toBuffer())
}

test('storage keys share one prefix and keep the entry key format the worker reads', () => {
  const digest = 'a'.repeat(64)
  assert.equal(pluginPackageObjectKey('acme-video', '1.2.0', digest), `plugin-packages/acme-video/1.2.0/${digest}.zip`)
  assert.equal(pluginIconObjectKey('acme-video', '1.2.0', digest, 'png'), `plugin-packages/acme-video/1.2.0/icon-${digest}.png`)
  assert.equal(pluginObjectKey('acme-video', '1.2.0', digest), `plugin-packages/acme-video/1.2.0/${digest}.mjs`)
})

test('a flat package validates into a normalized description', async () => {
  const icon = await pngIcon(64)
  const result = inspectPluginPackage(pack(files({
    'manifest.json': manifestJson({ ...PACKAGE_BLOCK, icon: 'assets/icon.png' }),
    assets: { 'icon.png': icon },
  })))
  assert.equal(result.ok, true, JSON.stringify(!result.ok && result.findings))
  if (!result.ok) return
  const expected = validatePluginManifest(MANIFEST)
  assert.ok(expected.ok)
  assert.deepEqual(result.package.manifest, expected.manifest)
  assert.deepEqual(result.package.meta, { license: 'MIT', author: 'Acme Inc.', homepage: 'https://acme.example/musecanvas' })
  assert.equal(result.package.entry.path, 'plugin.mjs')
  assert.equal(result.package.entry.source, BUNDLE)
  assert.equal(result.package.readme?.path, 'README.md')
  assert.match(result.package.readme?.text ?? '', /Renders video/)
  assert.equal(result.package.changelog?.path, 'CHANGELOG.md')
  assert.equal(result.package.license?.text, 'MIT License\n')
  assert.deepEqual(result.package.files.map(file => file.path), ['CHANGELOG.md', 'LICENSE', 'README.md', 'assets/icon.png', 'manifest.json', 'plugin.mjs'])
  assert.equal(result.package.files.find(file => file.path === 'plugin.mjs')?.sizeBytes, text(BUNDLE).byteLength)
  assert.deepEqual(
    { path: result.package.icon?.path, mimeType: result.package.icon?.mimeType, width: result.package.icon?.width, height: result.package.icon?.height },
    { path: 'assets/icon.png', mimeType: 'image/png', width: 64, height: 64 },
  )
  assert.equal(result.package.strippedRoot, null)
  assert.deepEqual(result.findings, [])
  // The full decode agrees with the header parse.
  assert.deepEqual(await decodePluginPackageIcon(icon, 'image/png', { width: 64, height: 64 }), { ok: true })
})

test('one wrapping directory is stripped; two levels or a mixed root are refused', () => {
  const wrapped: Zippable = { 'acme-video-1.2.0': files() }
  const result = inspectPluginPackage(pack(wrapped))
  assert.equal(result.ok, true, JSON.stringify(!result.ok && result.findings))
  if (result.ok) {
    assert.equal(result.package.strippedRoot, 'acme-video-1.2.0')
    assert.ok(result.package.files.every(file => !file.path.startsWith('acme-video-1.2.0')))
  }
  expectReject(inspectPluginPackage(pack({ outer: { inner: files() } })), 'PLUGIN_PACKAGE_INVALID')
  expectReject(inspectPluginPackage(pack({ wrap: files(), 'NOTES.md': text('x') })), 'PLUGIN_PACKAGE_INVALID')
})

test('macOS Finder metadata (__MACOSX/, .DS_Store) is dropped silently but still counts toward the caps', () => {
  // Finder's "Compress acme-video-1.2.0": a wrapping directory plus a sibling
  // __MACOSX/ tree of AppleDouble forks, and .DS_Store files at any level.
  const finder: Zippable = {
    'acme-video-1.2.0': { ...files(), '.DS_Store': text('\u0000\u0000\u0000\u0001Bud1'), assets: { '.DS_Store': text('Bud1') } },
    __MACOSX: { 'acme-video-1.2.0': { '._manifest.json': text('\u0000\u0005\u0016\u0007'), '._plugin.mjs': text('\u0000\u0005\u0016\u0007') } },
  }
  const wrapped = inspectPluginPackage(pack(finder))
  assert.equal(wrapped.ok, true, JSON.stringify(!wrapped.ok && wrapped.findings))
  if (wrapped.ok) {
    assert.equal(wrapped.package.strippedRoot, 'acme-video-1.2.0')
    assert.deepEqual(wrapped.package.files.map(file => file.path), ['CHANGELOG.md', 'LICENSE', 'README.md', 'manifest.json', 'plugin.mjs'])
    assert.deepEqual(wrapped.findings, [])
  }
  // Flat layout too.
  const flat = inspectPluginPackage(pack(files({ '.DS_Store': text('Bud1'), __MACOSX: { '._plugin.mjs': text('x') } })))
  assert.equal(flat.ok, true, JSON.stringify(!flat.ok && flat.findings))
  if (flat.ok) assert.equal(flat.package.files.some(file => file.path.includes('DS_Store') || file.path.includes('__MACOSX')), false)
  // Only the exact Finder names are ignored; look-alikes stay forbidden.
  expectReject(inspectPluginPackage(pack(files({ 'DS_Store.bin': text('x') }))), 'PLUGIN_PACKAGE_FORBIDDEN_FILE', 'DS_Store.bin')
  expectReject(inspectPluginPackage(pack(files({ __macosx: { 'x.bin': text('x') } }))), 'PLUGIN_PACKAGE_FORBIDDEN_FILE', '__macosx/x.bin')
  // Ignored entries still pass path safety.
  expectReject(inspectPluginPackage(pack(files({ '__MACOSX/../evil.md': text('x') }))), 'PLUGIN_PACKAGE_UNSAFE_PATH')
  // Junk alone is not a package.
  expectReject(inspectPluginPackage(pack({ '.DS_Store': text('Bud1') })), 'PLUGIN_PACKAGE_INVALID')

  // Entry cap: ignored records still count.
  const crowded: Zippable = files()
  for (let index = 0; index < PLUGIN_PACKAGE_MAX_ENTRIES; index++) crowded[`__MACOSX/._n${index}`] = text('x')
  expectReject(inspectPluginPackage(pack(crowded)), 'PLUGIN_PACKAGE_TOO_LARGE')

  // Uncompressed total: ignored bytes still count, and are never inflated.
  const entry = (name: string, size: number): PluginZipEntry => ({
    name,
    nameIsUtf8: true,
    nameByteLength: name.length,
    isDirectory: false,
    method: 8,
    compressedSize: Math.ceil(size / 10),
    uncompressedSize: size,
    versionMadeBy: 20,
    externalAttributes: 0,
    read: () => { throw new Error('must not inflate') },
  })
  expectReject(
    validatePluginPackageEntries([entry('manifest.json', 1_000), entry('plugin.mjs', 1_000), entry('__MACOSX/._big', 8 * 1024 * 1024)]),
    'PLUGIN_PACKAGE_TOO_LARGE',
  )
  assert.equal(isIgnoredPackagePath('__MACOSX/'), true)
  assert.equal(isIgnoredPackagePath('wrap/__MACOSX/._a'), true)
  assert.equal(isIgnoredPackagePath('docs/.DS_Store'), true)
  assert.equal(isIgnoredPackagePath('docs/x.DS_Store'), false)
})

test('scan warnings travel with the package and carry the entry path', () => {
  const result = inspectPluginPackage(pack(files({ 'plugin.mjs': text(BUNDLE.replace('export default', 'const plugin =')) })))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.warnings.map(finding => [finding.rule, finding.path]), [['NO_DEFAULT_EXPORT', 'plugin.mjs']])
})

test('path traversal, absolute paths, backslashes and control characters are refused', () => {
  for (const name of ['../evil.md', 'docs/../../evil.md', '/etc/evil.md', 'docs\\evil.md', 'C:/evil.md', 'bad\u0001.md', 'docs//x.md', './x.md']) {
    expectReject(inspectPluginPackage(pack(files({ [name]: text('x') }))), 'PLUGIN_PACKAGE_UNSAFE_PATH', name)
  }
  expectReject(inspectPluginPackage(pack(files({ [`${'d'.repeat(198)}.md`]: text('x') }))), 'PLUGIN_PACKAGE_UNSAFE_PATH')
})

test('symbolic links and device entries are refused by their external attributes', () => {
  const link: Zippable = files({ 'docs.md': [text('/etc/passwd'), { os: 3, attrs: (0o120777 << 16) >>> 0 }] })
  expectReject(inspectPluginPackage(pack(link)), 'PLUGIN_PACKAGE_UNSAFE_PATH', 'docs.md')
  const device: Zippable = files({ 'tty.md': [text(''), { os: 3, attrs: (0o020666 << 16) >>> 0 }] })
  expectReject(inspectPluginPackage(pack(device)), 'PLUGIN_PACKAGE_UNSAFE_PATH', 'tty.md')
  // A regular Unix file mode is fine.
  const regular: Zippable = files({ 'ok.md': [text('ok'), { os: 3, attrs: (0o100644 << 16) >>> 0 }] })
  assert.equal(inspectPluginPackage(pack(regular)).ok, true)
})

test('names that collide after case or Unicode folding are refused', () => {
  expectReject(inspectPluginPackage(pack(files({ 'readme.md': text('shadow') }))), 'PLUGIN_PACKAGE_UNSAFE_PATH', 'readme.md')
  const nfc = 'caf\u00e9.md'
  const nfd = 'cafe\u0301.md'
  expectReject(inspectPluginPackage(pack(files({ [nfc]: text('a'), [nfd]: text('b') }))), 'PLUGIN_PACKAGE_UNSAFE_PATH', nfd)
})

test('encrypted entries, zip64 and unsupported compression methods are refused', () => {
  const encrypted = pack(files())
  const at = locate(encrypted, 'README.md')
  const view = new DataView(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength)
  view.setUint16(at.central + 8, view.getUint16(at.central + 8, true) | 1, true)
  view.setUint16(at.local + 6, view.getUint16(at.local + 6, true) | 1, true)
  expectReject(inspectPluginPackage(encrypted), 'PLUGIN_PACKAGE_INVALID', 'README.md')

  const zip64Entry = pack(files())
  const entry = locate(zip64Entry, 'LICENSE')
  new DataView(zip64Entry.buffer).setUint32(entry.central + 24, 0xffffffff, true)
  expectReject(inspectPluginPackage(zip64Entry), 'PLUGIN_PACKAGE_INVALID', 'LICENSE')

  // A zip64 end-of-directory locator in front of the classic record.
  const plain = pack(files())
  const eocd = plain.length - 22
  const locator = new Uint8Array(20)
  new DataView(locator.buffer).setUint32(0, 0x07064b50, true)
  const zip64 = new Uint8Array(plain.length + 20)
  zip64.set(plain.subarray(0, eocd), 0)
  zip64.set(locator, eocd)
  zip64.set(plain.subarray(eocd), eocd + 20)
  expectReject(inspectPluginPackage(zip64), 'PLUGIN_PACKAGE_INVALID')

  const bzip = pack(files())
  const bz = locate(bzip, 'README.md')
  const bzView = new DataView(bzip.buffer)
  bzView.setUint16(bz.central + 10, 12, true)
  bzView.setUint16(bz.local + 8, 12, true)
  expectReject(inspectPluginPackage(bzip), 'PLUGIN_PACKAGE_INVALID', 'README.md')

  // Directory and local header must agree.
  const drift = pack(files())
  const dr = locate(drift, 'README.md')
  new DataView(drift.buffer).setUint32(drift.byteOffset + dr.local + 14, 0xdeadbeef, true)
  expectReject(inspectPluginPackage(drift), 'PLUGIN_PACKAGE_INVALID', 'README.md')

  expectReject(inspectPluginPackage(text('not a zip at all')), 'PLUGIN_PACKAGE_INVALID')
})

test('a second .mjs, an .svg icon and other non-whitelisted files are refused', () => {
  expectReject(inspectPluginPackage(pack(files({ 'lib/helper.mjs': text('export const x = 1') }))), 'PLUGIN_PACKAGE_FORBIDDEN_FILE', 'lib/helper.mjs')
  expectReject(inspectPluginPackage(pack(files({ 'assets/icon.svg': text('<svg onload="alert(1)"/>') }))), 'PLUGIN_PACKAGE_FORBIDDEN_FILE', 'assets/icon.svg')
  expectReject(
    inspectPluginPackage(pack(files({ 'manifest.json': manifestJson({ ...PACKAGE_BLOCK, icon: 'assets/icon.svg' }) }))),
    'PLUGIN_PACKAGE_FORBIDDEN_FILE',
    'manifest.json',
  )
  for (const name of ['index.js', 'data.json', 'native.node', 'lib.wasm', 'nested.zip', 'page.html']) {
    expectReject(inspectPluginPackage(pack(files({ [name]: text('x') }))), 'PLUGIN_PACKAGE_FORBIDDEN_FILE', name)
  }
})

test('an icon must be referenced, well-formed and at most 512px per edge', async () => {
  expectReject(inspectPluginPackage(pack(files({ 'icon.png': await pngIcon(32) }))), 'PLUGIN_PACKAGE_FORBIDDEN_FILE', 'icon.png')
  expectReject(
    inspectPluginPackage(pack(files({ 'manifest.json': manifestJson({ ...PACKAGE_BLOCK, icon: 'icon.png' }), 'icon.png': await pngIcon(600) }))),
    'PLUGIN_PACKAGE_TOO_LARGE',
    'icon.png',
  )
  expectReject(
    inspectPluginPackage(pack(files({ 'manifest.json': manifestJson({ ...PACKAGE_BLOCK, icon: 'icon.png' }), 'icon.png': text('not a png') }))),
    'PLUGIN_PACKAGE_INVALID',
    'icon.png',
  )
  const webp = new Uint8Array(await sharp({ create: { width: 48, height: 40, channels: 3, background: '#00f' } }).webp().toBuffer())
  assert.deepEqual(inspectIconHeader(webp), { mimeType: 'image/webp', extension: 'webp', width: 48, height: 40, animated: false })
  // Content and extension must agree.
  expectReject(
    inspectPluginPackage(pack(files({ 'manifest.json': manifestJson({ ...PACKAGE_BLOCK, icon: 'icon.png' }), 'icon.png': webp }))),
    'PLUGIN_PACKAGE_INVALID',
    'icon.png',
  )
  const ok = inspectPluginPackage(pack(files({ 'manifest.json': manifestJson({ ...PACKAGE_BLOCK, icon: 'icon.webp' }), 'icon.webp': webp })))
  assert.equal(ok.ok, true)
  // A valid header over garbage pixels passes the pure check but not the decode.
  const png = await pngIcon(16)
  const corrupt = png.slice()
  corrupt.fill(0x41, 40, corrupt.length - 12)
  assert.notEqual(inspectIconHeader(corrupt), null)
  assert.equal((await decodePluginPackageIcon(corrupt, 'image/png', { width: 16, height: 16 })).ok, false)
})

test('a compression ratio above 100:1 is a bomb', () => {
  const padded = BUNDLE + `/*${' '.repeat(2 * 1024 * 1024)}*/\n`
  expectReject(inspectPluginPackage(pack(files({ 'plugin.mjs': text(padded) }))), 'PLUGIN_PACKAGE_BOMB', 'plugin.mjs')
})

test('a stream that inflates past its declared size is a bomb, even under the ratio', () => {
  const zip = pack(files({ 'NOTES.md': text('a'.repeat(4000)) }))
  const at = locate(zip, 'NOTES.md')
  const view = new DataView(zip.buffer)
  // Claim fewer bytes than the stream holds, in both headers (CRC is checked last).
  view.setUint32(at.central + 24, 100, true)
  view.setUint32(at.local + 22, 100, true)
  expectReject(inspectPluginPackage(zip), 'PLUGIN_PACKAGE_BOMB', 'NOTES.md')
})

test('size limits: zip, per-file, entry count and uncompressed total', () => {
  expectReject(inspectPluginPackage(new Uint8Array(PLUGIN_PACKAGE_MAX_BYTES + 1)), 'PLUGIN_PACKAGE_TOO_LARGE')
  const tooMany: Zippable = files()
  for (let index = 0; index < PLUGIN_PACKAGE_MAX_ENTRIES; index++) tooMany[`docs/n${index}.md`] = text('x')
  expectReject(inspectPluginPackage(pack(tooMany)), 'PLUGIN_PACKAGE_TOO_LARGE')
  // Pseudo-random text so the ratio check stays out of the way.
  let seed = 7
  const noise = (length: number) => {
    let out = ''
    while (out.length < length) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      out += seed.toString(36)
    }
    return out.slice(0, length)
  }
  expectReject(inspectPluginPackage(pack(files({ 'README.md': text(noise(256 * 1024 + 1)) }))), 'PLUGIN_PACKAGE_TOO_LARGE', 'README.md')

  // The total is checked from declared sizes before anything inflates, so this
  // fixture never needs 8 MiB of real data.
  const entry = (name: string, size: number): PluginZipEntry => ({
    name,
    nameIsUtf8: true,
    nameByteLength: name.length,
    isDirectory: false,
    method: 8,
    compressedSize: Math.ceil(size / 10),
    uncompressedSize: size,
    versionMadeBy: 20,
    externalAttributes: 0,
    read: () => { throw new Error('must not inflate') },
  })
  const entries = [entry('manifest.json', 1_000), entry('plugin.mjs', 4 * 1024 * 1024)]
  for (let index = 0; index < 17; index++) entries.push(entry(`docs/${index}.md`, 256 * 1024))
  expectReject(validatePluginPackageEntries(entries), 'PLUGIN_PACKAGE_TOO_LARGE')
})

test('the package block and entry are required and checked', () => {
  expectReject(inspectPluginPackage(pack(files({ 'manifest.json': text(JSON.stringify(MANIFEST)) }))), 'PLUGIN_PACKAGE_ENTRY_MISSING', 'manifest.json')
  expectReject(inspectPluginPackage(pack(files({ 'manifest.json': manifestJson({ ...PACKAGE_BLOCK, entry: 'dist/plugin.mjs' }) }))), 'PLUGIN_PACKAGE_ENTRY_MISSING')
  const noBundle = files()
  delete noBundle['plugin.mjs']
  expectReject(inspectPluginPackage(pack(noBundle)), 'PLUGIN_PACKAGE_ENTRY_MISSING')
  expectReject(inspectPluginPackage(pack(files({ 'manifest.json': manifestJson({ ...PACKAGE_BLOCK, format: 2 }) }))), 'PLUGIN_PACKAGE_INVALID')
  expectReject(inspectPluginPackage(pack(files({ 'manifest.json': manifestJson({ ...PACKAGE_BLOCK, homepage: 'http://acme.example' }) }))), 'PLUGIN_PACKAGE_INVALID')
  expectReject(inspectPluginPackage(pack(files({ 'manifest.json': manifestJson({ ...PACKAGE_BLOCK, minHostVersion: '1.0.0' }) }))), 'PLUGIN_PACKAGE_INVALID')
  expectReject(inspectPluginPackage(pack(files({ 'manifest.json': text('{oops') }))), 'INVALID_PLUGIN_MANIFEST', 'manifest.json')
})

test('manifest and scan errors are reported together, each with its file', () => {
  const unsafe = 'const x = process.env.SECRET\nexport default { x }\n'
  const result = inspectPluginPackage(pack(files({
    'manifest.json': manifestJson(PACKAGE_BLOCK, { allowedHosts: ['localhost'] }),
    'plugin.mjs': text(unsafe),
  })))
  expectReject(result, 'PLUGIN_SCAN_FAILED')
  if (result.ok) return
  const byRule = new Map(result.findings.map(finding => [finding.rule, finding.path]))
  assert.equal(byRule.get('FORBIDDEN_PROCESS_ENV'), 'plugin.mjs')
  assert.equal(byRule.get('PRIVATE_HOST_FORBIDDEN'), 'manifest.json')
})

test('documents must be UTF-8 without NUL', () => {
  expectReject(inspectPluginPackage(pack(files({ 'README.md': new Uint8Array([0x23, 0xff, 0xfe, 0x0a]) }))), 'PLUGIN_PACKAGE_INVALID', 'README.md')
  expectReject(inspectPluginPackage(pack(files({ 'NOTES.txt': text('a\u0000b') }))), 'PLUGIN_PACKAGE_INVALID', 'NOTES.txt')
  // A UTF-8 BOM is accepted and stripped.
  const bom = inspectPluginPackage(pack(files({ 'README.md': new Uint8Array([0xef, 0xbb, 0xbf, ...text('# hi')]) })))
  assert.equal(bom.ok && bom.package.readme?.text, '# hi')
})

test('crc32 matches the reference value', () => {
  assert.equal(crc32(text('123456789')), 0xcbf43926)
})

test('createPluginPackageZip is deterministic and yields a package the validator accepts', () => {
  const contents = { 'manifest.json': manifestJson(), 'plugin.mjs': text(BUNDLE) }
  const first = createPluginPackageZip(contents)
  assert.deepEqual(createPluginPackageZip(contents), first)
  assert.equal(inspectPluginPackage(first).ok, true)
})
