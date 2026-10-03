import type * as SharpModule from 'sharp'
import {
  PLUGIN_PACKAGE_ICON_MAX_EDGE,
  type PluginPackageIconMimeType,
} from './plugin-package'

/**
 * Full decode of a package icon, the second half of §4 step 7. `inspectPluginPackage`
 * already parsed the container header (format, dimensions, animation, completeness);
 * this forces a real pixel decode so a well-formed header over corrupt or polyglot
 * data is refused before the icon is stored and served to the admin console.
 *
 * Kept out of plugin-package.ts because sharp is a native module: that file stays
 * pure (shared with tests and, potentially, a browser precheck), and this one is
 * only ever awaited by the API on an actual upload.
 */
export async function decodePluginPackageIcon(
  bytes: Uint8Array,
  mimeType: PluginPackageIconMimeType,
  expected: { width: number; height: number },
): Promise<{ ok: true } | { ok: false; message: string }> {
  // Dynamic import with webpackIgnore, as in output-image.ts: bundlers must not
  // traverse the native binding, and only an upload pays for loading it.
  const sharpPackage = ['sh', 'arp'].join('')
  const sharpModule: typeof SharpModule = await import(/* webpackIgnore: true */ sharpPackage)
  const sharp = sharpModule.default
  const options = {
    failOn: 'error' as const,
    limitInputPixels: PLUGIN_PACKAGE_ICON_MAX_EDGE * PLUGIN_PACKAGE_ICON_MAX_EDGE,
  }
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let meta: { format?: string; width?: number; height?: number; pages?: number }
  try {
    meta = await sharp(data, options).metadata()
  } catch {
    return { ok: false, message: 'icon failed to decode' }
  }
  const format = mimeType === 'image/png' ? 'png' : 'webp'
  if (meta.format !== format) return { ok: false, message: `icon decodes as ${meta.format ?? 'unknown'}, not ${format}` }
  if ((meta.pages ?? 1) > 1) return { ok: false, message: 'animated icons are not supported' }
  if (meta.width !== expected.width || meta.height !== expected.height) {
    return { ok: false, message: 'icon dimensions disagree with its header' }
  }
  try {
    await sharp(data, options).stats()
  } catch {
    return { ok: false, message: 'icon pixel data failed to decode' }
  }
  return { ok: true }
}
