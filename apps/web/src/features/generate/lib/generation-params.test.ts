// Focused browser-safe unit tests for generation parameter
// normalization and control precedence (no DOM, no Vue).
// Runs under the project's TypeScript test runner (vitest-compatible
// node:test style: describe/it + assert only).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  availableDurations,
  availableResolutions,
  buildGenerationInputs,
  buildVideoParameters,
  estimateModelCredits,
  firstLastFrameViolations,
  normalizeVideoControls,
  resolveInputSlots,
} from './generation-params'

describe('availableDurations', () => {
  it('falls back to 4/6/8 without descriptors', () => {
    assert.deepEqual(availableDurations(null), [4, 6, 8])
  })
  it('descriptor enum options take precedence', () => {
    assert.deepEqual(
      availableDurations({ parameters: [{ type: 'enum', name: 'duration', options: ['4', '8'] }] }),
      [4, 8],
    )
  })
  it('integer min/max clamps the fallback set', () => {
    assert.deepEqual(
      availableDurations({ parameters: [{ type: 'integer', name: 'duration', min: 5, max: 8 }] }),
      [6, 8],
    )
  })
})

describe('availableResolutions', () => {
  it('does not advertise 4k unless the descriptor lists it', () => {
    assert.deepEqual(availableResolutions(null), ['720p', '1080p'])
    assert.deepEqual(
      availableResolutions({ parameters: [{ type: 'enum', name: 'resolution', options: ['720p', '4k'] }] }),
      ['720p', '4k'],
    )
  })
})

describe('normalizeVideoControls precedence', () => {
  const model = {
    maxCount: 2,
    parameters: [
      { type: 'enum', name: 'aspect_ratio', options: ['16:9', '9:16'], defaultValue: '9:16' },
      { type: 'enum', name: 'resolution', options: ['720p', '1080p'] },
    ],
  } as const

  it('explicit controls win over descriptor defaults', () => {
    const out = normalizeVideoControls(model as never, {
      durationSeconds: 6, aspectRatio: '16:9', resolution: '1080p', audio: false, count: 2,
    })
    assert.equal(out.durationSeconds, 6)
    assert.equal(out.aspectRatio, '16:9')
    assert.equal(out.resolution, '1080p')
    assert.equal(out.audio, false)
    assert.equal(out.count, 2)
  })

  it('falls back to descriptor defaults, then hardcoded fallbacks', () => {
    const out = normalizeVideoControls(model as never, {})
    assert.equal(out.aspectRatio, '9:16')
    assert.equal(out.resolution, '720p')
    assert.equal(out.durationSeconds, 4)
    assert.equal(out.audio, true)
  })

  it('clamps unsupported values and count overflow', () => {
    const out = normalizeVideoControls(model as never, {
      durationSeconds: 99, aspectRatio: '1:1', resolution: '4k', count: 9,
    })
    assert.equal(out.durationSeconds, 4)
    assert.equal(out.aspectRatio, '9:16')
    assert.equal(out.resolution, '720p')
    assert.equal(out.count, 2)
  })
})

describe('buildVideoParameters', () => {
  it('emits both snake_case and camelCase aliases', () => {
    const params = buildVideoParameters({ durationSeconds: 8, aspectRatio: '9:16', resolution: '720p', audio: true, count: 1 })
    assert.equal(params.duration, 8)
    assert.equal(params.durationSeconds, 8)
    assert.equal(params.aspect_ratio, '9:16')
    assert.equal(params.aspectRatio, '9:16')
  })
})

describe('inputs', () => {
  it('builds stable positions and defaults role to reference_image', () => {
    const inputs = buildGenerationInputs([
      { uploadId: 'a', status: 'ready' },
      { uploadId: undefined, status: 'ready' },
      { uploadId: 'b', status: 'ready', role: 'first_frame' },
    ] as never)
    assert.deepEqual(inputs, [
      { uploadId: 'a', role: 'reference_image', position: 0 },
      { uploadId: 'b', role: 'first_frame', position: 1 },
    ])
  })

  it('rejects duplicated/misplaced first/last frames', () => {
    assert.deepEqual(firstLastFrameViolations([{ role: 'reference_image' }, { role: 'first_frame' }]), ['首帧图片必须放在第一位'])
    assert.deepEqual(firstLastFrameViolations([{ role: 'first_frame' }, { role: 'first_frame' }]), ['只能设置一张首帧图片'])
    assert.deepEqual(firstLastFrameViolations([{ role: 'first_frame' }, { role: 'last_frame' }]), [])
  })

  it('derives slots from maxInputImages when descriptors are absent', () => {
    assert.deepEqual(resolveInputSlots({ maxInputImages: 2 }), [{
      role: 'reference_image', required: false, minCount: 0, maxCount: 2, allowedMediaKinds: ['image'],
    }])
    assert.deepEqual(resolveInputSlots({ maxInputImages: 0 }), [])
  })
})

describe('estimateModelCredits', () => {
  it('prices video per second x count', () => {
    const credits = estimateModelCredits(
      { modelKind: 'video', pricing: { scheme: 'per_second_v1', creditsPerSecond: 10 } },
      { count: 1, durationSeconds: 6 },
    )
    assert.equal(credits, 60)
  })
  it('keeps legacy per-image pricing for image models', () => {
    const credits = estimateModelCredits(
      { modelKind: 'image', creditsPerImage: 5 },
      { count: 2, durationSeconds: 8 },
    )
    assert.equal(credits, 10)
  })
})
