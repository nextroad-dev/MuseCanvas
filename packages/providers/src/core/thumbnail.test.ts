import test from 'node:test'
import assert from 'node:assert/strict'
import {
  THUMBNAIL_LONG_EDGE,
  buildImageThumbnail,
  buildDerivedPreview,
  extractVideoPoster,
  isFfmpegAvailable,
  thumbnailStorageKey,
  MAX_THUMBNAIL_SOURCE_BYTES,
} from './thumbnail'

/** A real decodable PNG at an arbitrary size, built with sharp itself. */
async function pngBuffer(width: number, height: number): Promise<Buffer> {
  const sharpModule = await import(/* webpackIgnore: true */ 'sharp')
  const sharp = sharpModule.default
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 22, g: 138, b: 73 },
    },
  })
    .png()
    .toBuffer()
}

test('thumbnail key is a pure function of the source key', () => {
  const source = 'user-1/run-2/0-a1b2c3d4e5f6.png'
  const first = thumbnailStorageKey(source, 'image')
  assert.equal(first, 'user-1/run-2/0-a1b2c3d4e5f6.thumb-512.webp')
  // Idempotent backfill depends on re-deriving the same target object.
  assert.equal(thumbnailStorageKey(source, 'image'), first)
  assert.equal(thumbnailStorageKey(source, 'video'), 'user-1/run-2/0-a1b2c3d4e5f6.thumb-512.jpg')
})

test('thumbnail key keeps directory prefix and survives a dotted user id', () => {
  assert.equal(
    thumbnailStorageKey('a/b/c.d.e/0-facade.mp4', 'video'),
    'a/b/c.d.e/0-facade.thumb-512.jpg',
  )
  // No extension at all: the key is kept whole rather than truncated to ''.
  assert.equal(thumbnailStorageKey('flatkey', 'image'), 'flatkey.thumb-512.webp')
})

test('image source becomes a smaller, capped WebP preview', async () => {
  const source = await pngBuffer(1600, 900)
  const result = await buildImageThumbnail(source, 'u/r/0-abc.png', 'image/png')
  assert.equal(result.state, 'ready')
  if (result.state !== 'ready') return
  assert.equal(result.preview.mimeType, 'image/webp')
  assert.equal(result.preview.objectKey, 'u/r/0-abc.thumb-512.webp')
  assert.equal(result.preview.width, THUMBNAIL_LONG_EDGE)
  assert.equal(result.preview.height, Math.round((900 / 1600) * THUMBNAIL_LONG_EDGE))
  assert.ok(result.preview.bytes.length < source.length, 'preview must weigh less than the source')
})

test('image preview never enlarges a small source', async () => {
  const source = await pngBuffer(300, 200)
  const result = await buildImageThumbnail(source, 'u/r/0-abc.png', 'image/png')
  assert.equal(result.state, 'ready')
  if (result.state !== 'ready') return
  assert.equal(result.preview.width, 300)
  assert.equal(result.preview.height, 200)
})

test('non-image and oversized sources are skipped, not thrown', async () => {
  const source = await pngBuffer(64, 64)
  assert.deepEqual(await buildImageThumbnail(source, 'u/r/0.mp4', 'video/mp4'), {
    state: 'skipped',
    reason: 'not_an_image',
  })
  const huge = Buffer.alloc(MAX_THUMBNAIL_SOURCE_BYTES + 1)
  const skipped = await buildImageThumbnail(huge, 'u/r/0.png', 'image/png')
  assert.equal(skipped.state, 'skipped')
  if (skipped.state === 'skipped') assert.equal(skipped.reason, 'source_too_large')
})

test('undecodable image bytes skip instead of throwing', async () => {
  const junk = Buffer.from('this is certainly not a png', 'utf8')
  const result = await buildImageThumbnail(junk, 'u/r/0.png', 'image/png')
  assert.equal(result.state, 'skipped')
  if (result.state === 'skipped') assert.equal(result.reason, 'image_decode_failed')
})

test('video extraction without ffmpeg degrades to skipped', async () => {
  const result = await extractVideoPoster(Buffer.alloc(16), 'u/r/0.mp4', 'video')
  if (isFfmpegAvailable()) {
    // A garbage buffer still must not throw on a host that has ffmpeg.
    assert.equal(result.state, 'skipped')
  } else {
    assert.deepEqual(result, { state: 'skipped', reason: 'ffmpeg_unavailable' })
  }
})

test('video extraction rejects non-video kinds', async () => {
  assert.deepEqual(await extractVideoPoster(Buffer.alloc(16), 'u/r/0.png', 'image'), {
    state: 'skipped',
    reason: 'not_a_video',
  })
})

test('dispatcher routes by media kind', async () => {
  const source = await pngBuffer(800, 800)
  const image = await buildDerivedPreview(source, 'u/r/0.png', 'image/png', 'image')
  assert.equal(image.state, 'ready')
  if (image.state === 'ready') assert.equal(image.preview.objectKey, 'u/r/0.thumb-512.webp')

  // The video route can only ever produce a JPEG poster under the .jpg key.
  const video = await buildDerivedPreview(source, 'u/r/0.mp4', 'video/mp4', 'video')
  if (video.state === 'ready') {
    assert.equal(video.preview.mimeType, 'image/jpeg')
    assert.equal(video.preview.objectKey, 'u/r/0.thumb-512.jpg')
  } else {
    assert.equal(video.state, 'skipped')
  }
})

/**
 * End-to-end poster extraction on a host that has ffmpeg.
 *
 * This is the only proof that the `-vf scale='min(512,iw)':-2` filter reaches
 * ffmpeg intact: there is no shell here, so the single quotes and the comma
 * inside `min()` survive (or collapse) exactly as this argv spells them, and a
 * mistake surfaces as an empty frame rather than a loud error.
 */
const posterSuite = isFfmpegAvailable() ? test : test.skip

posterSuite('video poster extraction downsamples to the 512px long edge', async () => {
  const clip = await synthesizeTestClip()
  if (clip === null) return
  const result = await extractVideoPoster(clip, 'u/r/0-abc.mp4', 'video')
  assert.equal(result.state, 'ready')
  if (result.state !== 'ready') return
  assert.equal(result.preview.mimeType, 'image/jpeg')
  assert.equal(result.preview.objectKey, 'u/r/0-abc.thumb-512.jpg')
  // 1280x720 scaled inside 512 -> 512x288, and the even-height `-2` holds.
  assert.equal(result.preview.width, THUMBNAIL_LONG_EDGE)
  assert.equal(result.preview.height % 2, 0)
  assert.ok(result.preview.bytes.length < clip.length, 'poster must weigh less than the clip')
})

/** A real 1s H.264 clip, or null when the host's ffmpeg cannot build one. */
async function synthesizeTestClip(): Promise<Buffer | null> {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawn } = await import('node:child_process')
  const directory = await mkdtemp(join(tmpdir(), 'muse-fixture-'))
  const clipPath = join(directory, 'testsrc.mp4')
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'ffmpeg',
        [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=15:duration=1',
          '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clipPath,
        ],
        { windowsHide: true },
      )
      child.once('error', reject)
      child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`fixture_exit_${String(code)}`))))
    })
    return await readFile(clipPath)
  } catch {
    return null
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => null)
  }
}
