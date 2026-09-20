import assert from 'node:assert/strict'
import test from 'node:test'

import type { MediaInputImage } from '../../../../packages/providers/src/core/types'
import type { ModelConfigRevisionEntity } from '../../../../packages/database/src/repositories/model-config-revisions'
import { buildMediaRequest } from './index'

/**
 * The job-row → plugin-request boundary.
 *
 * This is where a declared parameter either reaches the vendor or does not, and
 * the failure mode is silent: a filter that drops `background` produces an image
 * that simply isn't transparent, with no error anywhere to explain it.
 */

const REVISION = { vendorModelId: 'gpt-image-2.5-sunburst' } as ModelConfigRevisionEntity

function requestFor(parameters: Record<string, unknown>, job: Record<string, unknown> = {}) {
  return buildMediaRequest(
    { media_kind: 'image', normalized_request: { parameters }, ...job },
    'a lighthouse at dusk',
    undefined,
    REVISION,
  )
}

test('every declared parameter reaches the plugin request', () => {
  const parameters = {
    size: '1536x1024',
    quality: 'max',
    count: 2,
    background: 'transparent',
    output_format: 'webp',
    output_compression: 80,
  }
  const request = requestFor(parameters)
  assert.deepEqual(request.parameters, parameters)
  // The typed fields keep being populated, because every existing plugin reads
  // them and the new bag is additive, not a replacement.
  assert.equal(request.size, '1536x1024')
  assert.equal(request.quality, 'max')
  assert.equal(request.count, 2)
})

test('the legacy extra mirror still agrees with the parameter bag', () => {
  // Regression fence for the deliberate duplication: the two video adapters read
  // `extra` today, so if the mirror ever stops matching they silently lose a
  // control while the plugin's own contract check keeps passing.
  const parameters: Record<string, unknown> = {
    duration: 8, resolution: '1080p', aspectRatio: '16:9', audio: true, seed: 42, fps: 24,
  }
  const request = buildMediaRequest(
    { media_kind: 'video', normalized_request: { parameters } },
    'a drone shot',
    undefined,
    { vendorModelId: 'doubao-seedance-2-0-fast-260128' } as ModelConfigRevisionEntity,
  )
  assert.deepEqual(request.extra, parameters, 'extra must mirror every declared control the adapters read')
  for (const [key, value] of Object.entries(parameters)) {
    assert.deepEqual(request.extra?.[key], value, `extra.${key}`)
    assert.deepEqual(request.parameters?.[key], value, `parameters.${key}`)
  }
})

test('a size on a video request still seeds the aspect ratio the adapters read', () => {
  const request = buildMediaRequest(
    { media_kind: 'video', normalized_request: { parameters: { size: '16:9' } } },
    'a drone shot',
    undefined,
    { vendorModelId: 'veo-3.1-generate-001' } as ModelConfigRevisionEntity,
  )
  assert.equal(request.extra?.aspectRatio, '16:9')
})

test('parameters are forwarded without re-filtering against the pinned revision', () => {
  // A job pinned to an older revision may legitimately carry a parameter the
  // current contract dropped. Removing it here would change what an in-flight
  // job sends; forwarding it lets the plugin, which owns the real decision, see
  // exactly what the API admitted.
  const request = requestFor({ size: '1024x1024', legacy_knob: 'keep-me' })
  assert.equal(request.parameters?.legacy_knob, 'keep-me')
})

test('an empty or absent parameter set does not invent an empty bag', () => {
  assert.equal(requestFor({}).parameters, undefined)
  assert.equal(
    buildMediaRequest({ media_kind: 'image' }, 'p', undefined, REVISION).parameters,
    undefined,
  )
})

test('stored roles including a mask are forwarded for placement', () => {
  const images: MediaInputImage[] = [
    { data: Buffer.from(''), mimeType: 'image/png', role: 'reference_image' },
    { data: Buffer.from(''), mimeType: 'image/png', role: 'mask' },
  ]
  const request = buildMediaRequest(
    { media_kind: 'image', normalized_request: { parameters: {} } },
    'repaint the sky',
    images,
    REVISION,
  )
  assert.deepEqual(request.extra?.imageRoles, ['reference_image', 'mask'])
})

test('an unplaceable stored role keeps positional inference instead of half-applying', () => {
  const images: MediaInputImage[] = [
    { data: Buffer.from(''), mimeType: 'image/png', role: 'reference_image' },
    { data: Buffer.from(''), mimeType: 'image/png', role: 'prompt_image' },
  ]
  const request = buildMediaRequest(
    { media_kind: 'image', normalized_request: { parameters: {} } },
    'p',
    images,
    REVISION,
  )
  assert.equal(request.extra?.imageRoles, undefined)
})
