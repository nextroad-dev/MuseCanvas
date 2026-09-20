import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import type * as SharpModule from 'sharp'

/**
 * Derived preview objects for the gallery.
 *
 * The library grid used to point every tile at the ORIGINAL `assets.object_key`,
 * so one screen of tiles downloaded one screen of full-resolution images, and
 * video tiles (which had no poster object at all) made the browser fetch video
 * header bytes just to paint frame zero. These helpers build a small preview
 * representation that the worker uploads next to the original and the API signs
 * as `thumbnailUrl`.
 *
 * Placement note: this lives in `packages/providers` rather than `apps/worker`
 * because sharp is a dependency of THIS package, and the worker already imports
 * providers sources by relative path. Keeping it here means zero new
 * dependencies and zero lockfile churn (the `@img/sharp-linuxmusl-x64` prebuild
 * the Alpine worker image needs is already resolved).
 */

/** Long edge of a derived preview, in CSS pixels. */
export const THUMBNAIL_LONG_EDGE = 512
/** WebP quality for image previews: visually indistinguishable at tile sizes. */
export const THUMBNAIL_WEBP_QUALITY = 78
/** JPEG quality for video posters, as ffmpeg's `-q:v` (lower is better). */
const POSTER_FFMPEG_Q = '4'
/** ffmpeg is killed past this budget; a poster is never worth a stalled worker. */
const FFMPEG_TIMEOUT_MS = 20_000
/** Sources above this are skipped: a preview must not cost more than the job. */
export const MAX_THUMBNAIL_SOURCE_BYTES = 40 * 1024 * 1024

export type DerivedMediaKind = 'image' | 'video'

/** A ready derived object, ready to upload under `objectKey`. */
export type DerivedPreview = {
  objectKey: string
  bytes: Buffer
  mimeType: string
  width: number
  height: number
}

export type DerivedPreviewResult =
  /** Preview produced; persist it and mark the asset 'ready'. */
  | { state: 'ready'; preview: DerivedPreview }
  /**
   * Deliberately not produced (no ffmpeg on this host, source too large, decode
   * rejected). The asset has no preview and the frontend falls back to the
   * original, so callers mark it 'failed' to stop backfill retrying forever.
   */
  | { state: 'skipped'; reason: string }

/**
 * Preview key derived purely from the source key: same prefix, same bucket,
 * stable across retries. Purity is what makes the backfill idempotent — running
 * it twice over the same asset targets the same object.
 */
export function thumbnailStorageKey(objectKey: string, mediaKind: DerivedMediaKind): string {
  const suffix = mediaKind === 'video' ? 'thumb-512.jpg' : 'thumb-512.webp'
  const stem = objectKey.replace(/\.[^./]+$/, '')
  return `${stem || objectKey}.${suffix}`
}

let ffmpegAvailability: boolean | null = null

/**
 * Cached one-shot probe for an `ffmpeg` binary on PATH.
 *
 * Containers get it from `deploy/docker/worker.Dockerfile` (Alpine's musl-native
 * package — `ffmpeg-static`'s binaries are glibc-linked and will not exec in a
 * `node:22-alpine` image). Local Windows dev usually has no ffmpeg, so this
 * returns false, video posters are skipped, image previews still work, and the
 * frontend keeps decoding frame zero itself. Degradation, never failure.
 */
export function isFfmpegAvailable(): boolean {
  if (ffmpegAvailability !== null) return ffmpegAvailability
  try {
    const probe = spawnSync('ffmpeg', ['-version'], { windowsHide: true })
    ffmpegAvailability = probe.status === 0
  } catch {
    ffmpegAvailability = false
  }
  return ffmpegAvailability
}

/** Test seam: forget the cached probe result. */
export function resetFfmpegAvailabilityCache(): void {
  ffmpegAvailability = null
}

async function loadSharp(): Promise<typeof SharpModule.default> {
  // Dynamic import with webpackIgnore (never a static import), mirroring
  // ./output-image.ts: API processes import the provider registry but never
  // decode outputs, and bundlers must not traverse the native binding.
  const sharpPackage = ['sh', 'arp'].join('')
  const sharpModule = await import(/* webpackIgnore: true */ sharpPackage) as typeof SharpModule
  return sharpModule.default
}

/**
 * Downscale a still image to a WebP preview.
 *
 * Single variant on purpose: the lightbox opens the original, and a 6-column
 * grid tile is ~220px wide, so a second 1024px rendition would be dead weight
 * carried on every asset row.
 */
export async function buildImageThumbnail(
  data: Buffer,
  objectKey: string,
  mimeType: string,
): Promise<DerivedPreviewResult> {
  if (!mimeType.startsWith('image/')) return { state: 'skipped', reason: 'not_an_image' }
  if (data.length > MAX_THUMBNAIL_SOURCE_BYTES) return { state: 'skipped', reason: 'source_too_large' }
  try {
    const sharp = await loadSharp()
    const rendered = await sharp(data, { animated: false, failOn: 'error' })
      .rotate()
      .resize(THUMBNAIL_LONG_EDGE, THUMBNAIL_LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: THUMBNAIL_WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true })
    const width = rendered.info.width
    const height = rendered.info.height
    if (!width || !height || rendered.data.length === 0) {
      return { state: 'skipped', reason: 'empty_preview' }
    }
    return {
      state: 'ready',
      preview: {
        objectKey: thumbnailStorageKey(objectKey, 'image'),
        bytes: rendered.data,
        mimeType: 'image/webp',
        width,
        height,
      },
    }
  } catch {
    // A preview is an optimisation; an undecodable source must not become a
    // failed generation job.
    return { state: 'skipped', reason: 'image_decode_failed' }
  }
}

/** ffmpeg args for one still frame; `-ss` before `-i` is a fast keyframe seek. */
function posterArgs(inputPath: string, outputPath: string, seekSeconds: number | null): string[] {
  const args = ['-y', '-hide_banner', '-loglevel', 'error']
  if (seekSeconds !== null) args.push('-ss', `${seekSeconds.toFixed(3)}`)
  args.push(
    '-i', inputPath,
    '-frames:v', '1',
    // Single quotes are parsed by ffmpeg's own filtergraph reader (there is no
    // shell here): the comma inside min() must survive, and `-2` keeps the
    // non-fixed edge even so the encoder accepts the frame.
    '-vf', "scale='min(512,iw)':-2",
    '-q:v', POSTER_FFMPEG_Q,
    outputPath,
  )
  return args
}

async function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // AbortSignal.timeout rather than a timer in the caller: the worker's own
    // source asserts it holds no setTimeout/setInterval/sleep of its own.
    const signal = AbortSignal.timeout(timeoutMs)
    const child = spawn('ffmpeg', args, { signal, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      // Bounded: the log line is only ever read for a reason string.
      if (stderr.length < 2000) stderr += chunk.toString('utf8')
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (signal.aborted) reject(new Error('ffmpeg_timeout'))
      else if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `ffmpeg_exit_${String(code)}`))
    })
  })
}

/**
 * Grab one frame from a video buffer as a JPEG poster.
 *
 * The frame doubles as the gallery preview: the caller writes it once and points
 * both `thumbnail_object_key` and the long-dormant `poster_object_key` at it,
 * which also gives the API a real `posterUrl` for free.
 */
export async function extractVideoPoster(
  data: Buffer,
  objectKey: string,
  mediaKind: DerivedMediaKind = 'video',
): Promise<DerivedPreviewResult> {
  if (mediaKind !== 'video') return { state: 'skipped', reason: 'not_a_video' }
  if (data.length > MAX_THUMBNAIL_SOURCE_BYTES) return { state: 'skipped', reason: 'source_too_large' }
  if (!isFfmpegAvailable()) return { state: 'skipped', reason: 'ffmpeg_unavailable' }
  let directory: string | null = null
  try {
    directory = await mkdtemp(join(tmpdir(), 'muse-poster-'))
    // Extension matters to ffmpeg's demuxer probe; the name is content-derived
    // so two concurrent extractions can never collide.
    const stamp = createHash('sha256').update(data.subarray(0, 256)).digest('hex').slice(0, 12)
    const inputPath = join(directory, `${stamp}.mp4`)
    const outputPath = join(directory, `${stamp}.jpg`)
    await writeFile(inputPath, data)
    // 100ms in skips black/empty lead-in frames; a hard 0 is the fallback for
    // streams whose first keyframe sits at the very front.
    for (const seek of [0.1, null]) {
      try {
        await runFfmpeg(posterArgs(inputPath, outputPath, seek), FFMPEG_TIMEOUT_MS)
      } catch {
        continue
      }
      const bytes = await readFile(outputPath)
      if (bytes.length > 0) {
        const size = await readJpegDimensions(bytes)
        return {
          state: 'ready',
          preview: {
            objectKey: thumbnailStorageKey(objectKey, 'video'),
            bytes,
            mimeType: 'image/jpeg',
            width: size.width,
            height: size.height,
          },
        }
      }
    }
    return { state: 'skipped', reason: 'poster_frame_undecodable' }
  } catch {
    return { state: 'skipped', reason: 'poster_extraction_failed' }
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => null)
  }
}

async function readJpegDimensions(bytes: Buffer): Promise<{ width: number; height: number }> {
  try {
    const sharp = await loadSharp()
    const meta = await sharp(bytes, { failOn: 'error' }).metadata()
    return { width: meta.width ?? 0, height: meta.height ?? 0 }
  } catch {
    return { width: 0, height: 0 }
  }
}

/**
 * Produce the preview object for one just-generated output, whatever its kind.
 *
 * Never throws for expected conditions (missing ffmpeg, undecodable bytes,
 * oversized source) — it reports `{ state: 'skipped' }` so the caller can mark
 * the asset and carry on with the job.
 */
export async function buildDerivedPreview(
  data: Buffer,
  objectKey: string,
  mimeType: string,
  mediaKind: DerivedMediaKind,
): Promise<DerivedPreviewResult> {
  return mediaKind === 'video'
    ? extractVideoPoster(data, objectKey, mediaKind)
    : buildImageThumbnail(data, objectKey, mimeType)
}
