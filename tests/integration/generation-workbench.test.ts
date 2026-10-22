import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { buildJobConfigReuse } from '../../apps/web/src/features/generate/lib/job-config-reuse'
import { cacheCreatedJob, prependCreatedJob } from '../../apps/web/src/shared/lib/created-job-cache'
import { useGenerateUiStore } from '../../apps/web/src/shared/stores/generate-ui-store'
import type { GenerationJob, ModelConfig } from '../../apps/web/src/shared/types'

const { QueryClient } = createRequire(new URL('../../apps/web/package.json', import.meta.url))('@tanstack/react-query')
const model = {
  id: 'image-model', modelKind: 'image', parameters: [
    { name: 'quality', type: 'enum', options: ['auto', 'high'], defaultValue: 'auto' },
    { name: 'count', type: 'integer', min: 1, max: 4, defaultValue: 1 },
  ],
} as ModelConfig
const job = {
  id: 'new', modelId: model.id, prompt: 'visible', inputPrompt: 'original', mediaKind: 'image',
  parameters: { quality: 'high', count: 2 }, outputs: [], status: 'queued',
} as GenerationJob

test('configuration reuse restores original input and compatible selections only', () => {
  const config = buildJobConfigReuse({ ...job, parameters: { quality: 'retired', count: 2, unknown: true } }, [model])
  assert.equal(config.prompt, 'original')
  assert.deepEqual(config.parameters, { count: 2 })
  assert.ok(config.notices.some((notice) => notice.includes('quality')))
  assert.ok(config.notices.some((notice) => notice.includes('未恢复参考图')))
})

test('missing model is explicit; never selects a silent replacement', () => {
  const config = buildJobConfigReuse({ ...job, modelId: 'removed' }, [model])
  assert.equal(config.model, null)
  assert.deepEqual(config.parameters, {})
  assert.ok(config.notices.some((notice) => notice.includes('不可用')))
})

test('legacy fields are validated and input dependencies are disclosed', () => {
  const config = buildJobConfigReuse({ ...job, parameters: undefined, quality: 'high', count: 999, inputs: [{ assetId: 'a', role: 'reference_image', position: 0 }] }, [model])
  assert.deepEqual(config.parameters, { quality: 'high' })
  assert.ok(config.notices.some((notice) => notice.includes('旧任务')))
  assert.ok(config.notices.some((notice) => notice.includes('重新添加')))
})

test('wire aliases are canonicalized before reconciling video parameters', () => {
  const video = { ...model, id: 'video', modelKind: 'video', parameters: [{ name: 'duration', type: 'integer', min: 1, max: 10 }] } as ModelConfig
  const config = buildJobConfigReuse({ ...job, modelId: 'video', mediaKind: 'video', parameters: { duration: 5 } }, [video])
  assert.equal(config.tab, 'video')
  assert.deepEqual(config.parameters, { durationSeconds: 5 })
})

test('synchronous shared lock prevents duplicate creation and draft/mode changes', () => {
  const store = useGenerateUiStore.getState()
  store.finishSubmission()
  store.resetForm()
  store.setActiveTab('image')
  store.setPrompt('snapshot')
  assert.equal(store.tryBeginSubmission(), true)
  assert.equal(store.tryBeginSubmission(), false)
  store.setActiveTab('video')
  store.setPrompt('later')
  store.setParam('image', 'count', 4)
  assert.equal(useGenerateUiStore.getState().activeTab, 'image')
  assert.equal(useGenerateUiStore.getState().prompt, 'snapshot')
  assert.deepEqual(useGenerateUiStore.getState().paramsByKind.image, {})
  store.finishSubmission()
  assert.equal(store.tryBeginSubmission(), true, 'another deliberate submission is allowed after creation')
  store.finishSubmission()
  store.resetForm()
})

test('background reference validation can remove an invalid pending row during edit creation', () => {
  const store = useGenerateUiStore.getState()
  store.finishSubmission()
  store.resetForm()
  store.addStagedImage({ localId: 'invalid-decode', source: 'upload', previewUrl: 'blob:fixture', mimeType: 'image/png', sizeBytes: 10, status: 'pending', progress: 0 })
  assert.equal(store.tryBeginSubmission(), true)
  // An already-started file decode may finish while an unrelated edit is creating.
  store.removeStagedImage('invalid-decode')
  assert.equal(useGenerateUiStore.getState().stagedImages.length, 0)
  assert.equal(useGenerateUiStore.getState().isGenerating, true)
  store.finishSubmission()
  store.resetForm()
})

test('created job is deduplicated and immediately published to all list caches', async () => {
  assert.deepEqual(prependCreatedJob([job, { ...job, id: 'old' }], job, 1), [job])
  const client = new QueryClient()
  client.setQueryData(['jobs'], [{ ...job, id: 'old' }])
  client.setQueryData(['jobs', 30], [{ ...job, id: 'old' }])
  client.setQueryData(['jobs', 'detail', 'old'], { ...job, id: 'old' })
  await cacheCreatedJob(client, job)
  assert.equal(client.getQueryData(['jobs'])[0].id, 'new')
  assert.equal(client.getQueryData(['jobs', 30])[0].id, 'new')
  assert.equal(client.getQueryData(['jobs', 'detail', 'old']).id, 'old')
  client.clear()
})

test('a pending stale GET cannot overwrite the published creation response', async () => {
  const client = new QueryClient()
  let resolve!: (value: GenerationJob[]) => void
  const pending = client.fetchQuery({ queryKey: ['jobs', 30], queryFn: () => new Promise<GenerationJob[]>((done) => { resolve = done }) }).catch(() => undefined)
  await cacheCreatedJob(client, job)
  resolve([{ ...job, id: 'old' }])
  await pending
  assert.equal(client.getQueryData(['jobs', 30])[0].id, 'new')
  client.clear()
})
