import test from 'node:test'
import assert from 'node:assert/strict'
import { componentHarness } from '../../../shared/components/ui/isolated-ui-fixes-test-harness.mjs'

test('studio observer refreshes library on outputs and completion across page changes, not every poll', () => {
  let data = { items: [{ id: 'job', status: 'queued', outputs: [] }] }
  const invalidations = []
  const client = { invalidateQueries: (key) => invalidations.push(key) }
  const harness = componentHarness(new URL('./workspace-job-observer.tsx', import.meta.url), 'WorkspaceJobObserver', {
    '@/shared/hooks/useJobs': { useJobs: () => ({ data }) },
    '@tanstack/react-query': { useQueryClient: () => client },
    '@/shared/hooks/query-keys': { queryKeys: { library: { root: ['library'] } } },
  })
  const render = () => { harness.render({}); harness.effects() }
  render()
  assert.equal(invalidations.length, 0)
  data = { items: [{ id: 'job', status: 'running', outputs: [{ assetId: 'asset' }] }] }
  render()
  assert.equal(invalidations.length, 1)
  data = { items: [{ id: 'job', status: 'succeeded', outputs: [{ assetId: 'asset' }] }] }
  render()
  assert.equal(invalidations.length, 2)
  data = { ...data }
  render()
  assert.equal(invalidations.length, 2)
  assert.equal(JSON.stringify(invalidations[0]), JSON.stringify({ queryKey: ['library'] }))
})
