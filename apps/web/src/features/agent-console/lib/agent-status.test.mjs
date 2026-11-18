import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AGENT_MESSAGE_MAX_BYTES,
  MAX_MEDIA_ASSETS_PER_JOB,
  MAX_MEDIA_JOBS,
  deriveSessionStatus,
  extractArtifactPreview,
  extractItemText,
  extractMediaJobs,
  extractToolPayloadInfo,
  formatAgentErrorCode,
  formatApprovalStatus,
  formatConnectionState,
  formatMediaJobStatus,
  formatSessionStatus,
  formatToolStatus,
  formatTurnStatus,
  isMessageOverLimit,
  isSafeDisplayUrl,
  isValidUuid,
  shortUuid,
  utf8ByteLength,
} from './agent-status.ts'
import { assetDetailHref } from '../../../shared/lib/app-routes.ts'

test('deriveSessionStatus and formatSessionStatus map lifecycle states cleanly', () => {
  assert.equal(deriveSessionStatus({ activeTurnId: null, archivedAt: null }), 'idle')
  assert.equal(deriveSessionStatus({ activeTurnId: 'turn-1', archivedAt: null }), 'active')
  assert.equal(deriveSessionStatus({ activeTurnId: 'turn-1', archivedAt: '2026-01-01T00:00:00Z' }), 'archived')

  assert.deepEqual(formatSessionStatus('active'), { label: '运行中', tone: 'accent' })
  assert.deepEqual(formatSessionStatus('idle'), { label: '空闲', tone: 'neutral' })
  assert.deepEqual(formatSessionStatus('archived'), { label: '已归档', tone: 'neutral' })
  assert.deepEqual(formatSessionStatus('closed'), { label: '已关闭', tone: 'neutral' })
  assert.deepEqual(formatSessionStatus('custom_unknown'), { label: '未知状态', tone: 'neutral' })
})

test('formatTurnStatus, formatToolStatus, formatApprovalStatus, and formatConnectionState map all variants', () => {
  assert.deepEqual(formatTurnStatus('queued'), { label: '排队中', tone: 'info' })
  assert.deepEqual(formatTurnStatus('running'), { label: '推理中', tone: 'accent' })
  assert.deepEqual(formatTurnStatus('waiting_tools'), { label: '等待工具', tone: 'info' })
  assert.deepEqual(formatTurnStatus('waiting_approval'), { label: '等待审批', tone: 'warning' })
  assert.deepEqual(formatTurnStatus('waiting_budget'), { label: '等待配额', tone: 'warning' })
  assert.deepEqual(formatTurnStatus('cancelling'), { label: '取消中', tone: 'warning' })
  assert.deepEqual(formatTurnStatus('running', { cancelRequestedAt: '2026-01-01T00:00:00Z' }), {
    label: '取消中',
    tone: 'warning',
  })
  assert.deepEqual(formatTurnStatus('completed'), { label: '已完成', tone: 'success' })
  assert.deepEqual(formatTurnStatus('failed'), { label: '失败', tone: 'danger' })
  assert.deepEqual(formatTurnStatus('failed', { errorCode: 'DEADLINE_EXCEEDED' }), {
    label: '已超时',
    tone: 'danger',
  })
  assert.deepEqual(formatTurnStatus('cancelled'), { label: '已取消', tone: 'neutral' })
  assert.deepEqual(formatTurnStatus('timed_out'), { label: '已超时', tone: 'danger' })

  assert.deepEqual(formatToolStatus('recorded'), { label: '已记录', tone: 'neutral' })
  assert.deepEqual(formatToolStatus('queued'), { label: '排队中', tone: 'neutral' })
  assert.deepEqual(formatToolStatus('validating'), { label: '校验中', tone: 'info' })
  assert.deepEqual(formatToolStatus('waiting_approval'), { label: '待审批', tone: 'warning' })
  assert.deepEqual(formatToolStatus('executing'), { label: '执行中', tone: 'accent' })
  assert.deepEqual(formatToolStatus('running'), { label: '执行中', tone: 'accent' })
  assert.deepEqual(formatToolStatus('waiting_external'), { label: '等待外部结果', tone: 'info' })
  assert.deepEqual(formatToolStatus('completed'), { label: '已完成', tone: 'success' })
  assert.deepEqual(formatToolStatus('failed'), { label: '失败', tone: 'danger' })
  assert.deepEqual(formatToolStatus('cancelled'), { label: '已取消', tone: 'neutral' })
  assert.deepEqual(formatToolStatus('timed_out'), { label: '已超时', tone: 'danger' })
  assert.deepEqual(formatToolStatus('skipped'), { label: '已跳过', tone: 'neutral' })

  assert.deepEqual(formatApprovalStatus('pending'), { label: '待审批', tone: 'warning' })
  assert.deepEqual(formatApprovalStatus('approved'), { label: '已批准', tone: 'success' })
  assert.deepEqual(formatApprovalStatus('rejected'), { label: '已拒绝', tone: 'danger' })
  assert.deepEqual(formatApprovalStatus('expired'), { label: '已过期', tone: 'neutral' })

  assert.deepEqual(formatConnectionState('idle'), { label: '未连接', tone: 'neutral' })
  assert.deepEqual(formatConnectionState('connecting'), { label: '连接中', tone: 'info' })
  assert.deepEqual(formatConnectionState('connected'), { label: '实时同步', tone: 'success' })
  assert.deepEqual(formatConnectionState('reconnecting'), { label: '重连中', tone: 'warning' })
  assert.deepEqual(formatConnectionState('resyncing'), { label: '同步快照', tone: 'info' })
  assert.deepEqual(formatConnectionState('error'), { label: '连接异常', tone: 'danger' })

  assert.match(formatAgentErrorCode('BUDGET_EXCEEDED'), /预算配额/)
  assert.equal(formatAgentErrorCode(null), '执行失败')
})

test('utf8ByteLength and isMessageOverLimit count multi-byte UTF-8 accurately', () => {
  assert.equal(AGENT_MESSAGE_MAX_BYTES, 32_000)
  assert.equal(utf8ByteLength('abc'), 3)
  assert.equal(utf8ByteLength('中'), 3)
  assert.equal(utf8ByteLength('🎨'), 4)

  const exactLimit = 'a'.repeat(32_000)
  assert.equal(isMessageOverLimit(exactLimit), false)
  assert.equal(isMessageOverLimit(`${exactLimit}a`), true)
  // 10,667 个中文字符 = 32,001 字节（字符数未超但字节已超限）
  assert.equal(isMessageOverLimit('中'.repeat(10_667)), true)
  assert.equal(isMessageOverLimit('中'.repeat(10_666)), false)
})

test('extractItemText, extractArtifactPreview, and extractToolPayloadInfo handle sparse live and rich mock payloads', () => {
  assert.equal(extractItemText({ type: 'user_message', payload: { content: '画一只猫' } }), '画一只猫')
  assert.equal(extractItemText({ type: 'system_event', payload: { message: '已取消' } }), '已取消')
  assert.equal(extractItemText({ type: 'tool_call', payload: {} }), '发起工具调用')
  assert.equal(extractItemText({ type: 'tool_call', payload: { toolName: 'generate_image' } }), '准备调用 generate_image')
  assert.equal(extractItemText({ type: 'approval', payload: {} }), '需要确认工具调用')

  // Live sparse artifact item only has content/message
  const sparseArtifact = extractArtifactPreview({ payload: { message: '已产出图库资产' } })
  assert.deepEqual(sparseArtifact, {
    assetId: null,
    url: null,
    thumbnailUrl: null,
    downloadUrl: null,
    width: null,
    height: null,
    mimeType: null,
    prompt: null,
    label: null,
    message: '已产出图库资产',
  })

  const richArtifact = extractArtifactPreview({
    payload: {
      assetId: 'asset-1',
      url: '/api/media/object?sig=1',
      thumbnailUrl: '/showcase/ceramics.webp',
      downloadUrl: '/api/library/asset-1/download',
      width: 1024,
      height: 1280,
      mimeType: 'image/webp',
      prompt: '陶瓷花瓶',
      label: '静物摄影',
      message: '已生成样片',
    },
  })
  assert.equal(richArtifact.assetId, 'asset-1')
  assert.equal(richArtifact.width, 1024)
  assert.equal(richArtifact.height, 1280)
  assert.equal(richArtifact.label, '静物摄影')

  const sparseTool = extractToolPayloadInfo({ payload: { content: 'running' } })
  assert.equal(sparseTool.message, 'running')
  assert.equal(sparseTool.toolName, null)
  assert.equal(sparseTool.approvalId, null)

  const richTool = extractToolPayloadInfo({
    payload: {
      toolName: 'generate_image',
      approvalId: 'app-1',
      status: 'waiting_approval',
      size: '1024x1024',
    },
  })
  assert.equal(richTool.toolName, 'generate_image')
  assert.equal(richTool.approvalId, 'app-1')
  assert.equal(richTool.size, '1024x1024')
})

const COMPLETED_ASSET_ID = '00000000-0000-4000-8000-000000000301'
const COMPLETED_ASSET_ID_2 = '00000000-0000-4000-8000-000000000302'
const MEDIA_JOB_ID = '00000000-0000-4000-8000-000000000201'
const FAILED_JOB_ID = '00000000-0000-4000-8000-000000000202'

function mediaToolResult(result) {
  return { content: JSON.stringify(result), status: 'completed', result, error: null }
}

test('extractMediaJobs reads the persisted tool_result result shape', () => {
  const jobs = extractMediaJobs(
    mediaToolResult({
      content: 'Media generation completed',
      jobs: [{ jobId: MEDIA_JOB_ID, status: 'succeeded', assetIds: [COMPLETED_ASSET_ID, COMPLETED_ASSET_ID_2] }],
    }),
  )
  assert.deepEqual(jobs, [
    { jobId: MEDIA_JOB_ID, status: 'succeeded', assetIds: [COMPLETED_ASSET_ID, COMPLETED_ASSET_ID_2] },
  ])
})

test('extractMediaJobs keeps failed and cancelled jobs without executing anything', () => {
  const jobs = extractMediaJobs({
    result: {
      content: 'Media generation failed.',
      jobs: [
        { jobId: FAILED_JOB_ID, status: 'failed', assetIds: [] },
        { jobId: MEDIA_JOB_ID, status: 'canceled', assetIds: [COMPLETED_ASSET_ID] },
      ],
    },
  })
  assert.deepEqual(jobs, [
    { jobId: FAILED_JOB_ID, status: 'failed', assetIds: [] },
    { jobId: MEDIA_JOB_ID, status: 'cancelled', assetIds: [COMPLETED_ASSET_ID] },
  ])
})

test('extractMediaJobs accepts flat and content-string payloads', () => {
  const flat = { jobs: [{ jobId: MEDIA_JOB_ID, status: 'running', assetIds: [] }] }
  assert.deepEqual(extractMediaJobs(flat), [
    { jobId: MEDIA_JOB_ID, status: 'running', assetIds: [] },
  ])
  const embedded = {
    content: JSON.stringify({ jobs: [{ jobId: MEDIA_JOB_ID, status: 'completed', assetIds: [COMPLETED_ASSET_ID] }] }),
  }
  assert.deepEqual(extractMediaJobs(embedded), [
    { jobId: MEDIA_JOB_ID, status: 'completed', assetIds: [COMPLETED_ASSET_ID] },
  ])
})

test('extractMediaJobs returns an empty array for malformed and foreign payloads', () => {
  assert.deepEqual(extractMediaJobs(null), [])
  assert.deepEqual(extractMediaJobs(undefined), [])
  assert.deepEqual(extractMediaJobs({}), [])
  assert.deepEqual(extractMediaJobs({ result: null }), [])
  assert.deepEqual(extractMediaJobs({ result: 'jobs' }), [])
  assert.deepEqual(extractMediaJobs({ jobs: 'not-an-array' }), [])
  assert.deepEqual(extractMediaJobs({ content: 'not json {' }), [])
  assert.deepEqual(extractMediaJobs({ content: 42, result: [1, 2, 3] }), [])
  assert.deepEqual(extractMediaJobs({ result: { jobs: [null, 1, 'job'] } }), [])
  // 未知字段与已知字段混在一起时只取已知字段
  assert.deepEqual(
    extractMediaJobs({ result: { jobs: [{ jobId: MEDIA_JOB_ID, status: 'succeeded', assetIds: [COMPLETED_ASSET_ID], provider: 'x' }] } }),
    [{ jobId: MEDIA_JOB_ID, status: 'succeeded', assetIds: [COMPLETED_ASSET_ID] }],
  )
})

test('extractMediaJobs drops non-UUID ids and unknown statuses', () => {
  const jobs = extractMediaJobs({
    result: {
      jobs: [
        { jobId: 'job-1', status: 'succeeded', assetIds: [COMPLETED_ASSET_ID] },
        { jobId: MEDIA_JOB_ID, status: 'exploded', assetIds: [COMPLETED_ASSET_ID] },
      ],
    },
  })
  assert.deepEqual(jobs, [])

  const mixed = extractMediaJobs({
    result: { jobs: [{ jobId: MEDIA_JOB_ID, status: 'succeeded', assetIds: ['asset-1', 7, COMPLETED_ASSET_ID] }] },
  })
  assert.deepEqual(mixed, [{ jobId: MEDIA_JOB_ID, status: 'succeeded', assetIds: [COMPLETED_ASSET_ID] }])
})

test('extractMediaJobs bounds job and asset counts', () => {
  const jobId = (index) => `00000000-0000-4000-8000-0000000002${String(index).padStart(2, '0')}`
  const assetId = (index) => `00000000-0000-4000-8000-0000000003${String(index).padStart(2, '0')}`
  const oversized = {
    result: {
      jobs: Array.from({ length: MAX_MEDIA_JOBS + 4 }, (_, index) => ({
        jobId: jobId(index),
        status: 'succeeded',
        assetIds: Array.from({ length: MAX_MEDIA_ASSETS_PER_JOB + 4 }, (_, assetIndex) => assetId(assetIndex)),
      })),
    },
  }
  const jobs = extractMediaJobs(oversized)
  assert.equal(jobs.length, MAX_MEDIA_JOBS)
  assert.equal(jobs[0].assetIds.length, MAX_MEDIA_ASSETS_PER_JOB)
  assert.equal(jobs[0].assetIds[0], assetId(0))
  assert.equal(jobs[0].assetIds.at(-1), assetId(MAX_MEDIA_ASSETS_PER_JOB - 1))

  const duplicated = extractMediaJobs({
    result: { jobs: [{ jobId: MEDIA_JOB_ID.toUpperCase(), status: 'SUCCEEDED', assetIds: [COMPLETED_ASSET_ID, COMPLETED_ASSET_ID.toUpperCase()] }] },
  })
  assert.deepEqual(duplicated, [{ jobId: MEDIA_JOB_ID, status: 'succeeded', assetIds: [COMPLETED_ASSET_ID] }])
})

test('formatMediaJobStatus reuses the existing tool status wording', () => {
  assert.deepEqual(formatMediaJobStatus('succeeded'), { label: '已完成', tone: 'success' })
  assert.deepEqual(formatMediaJobStatus('completed'), { label: '已完成', tone: 'success' })
  assert.deepEqual(formatMediaJobStatus('failed'), { label: '失败', tone: 'danger' })
  assert.deepEqual(formatMediaJobStatus('cancelled'), { label: '已取消', tone: 'neutral' })
  assert.deepEqual(formatMediaJobStatus('running'), { label: '执行中', tone: 'accent' })
})

test('completed media results produce asset detail links, malformed payloads produce none', () => {
  const completedJobs = extractMediaJobs(
    mediaToolResult({
      content: 'Media generation completed',
      jobs: [{ jobId: MEDIA_JOB_ID, status: 'succeeded', assetIds: [COMPLETED_ASSET_ID] }],
    }),
  )
  const links = completedJobs.flatMap((job) => job.assetIds.map((assetId) => assetDetailHref(assetId)))
  assert.deepEqual(links, [`/library?asset=${COMPLETED_ASSET_ID}`])

  const malformedJobs = extractMediaJobs({
    result: { jobs: [{ jobId: 'job-1', status: 'succeeded', assetIds: ['asset-1', COMPLETED_ASSET_ID] }] },
  })
  assert.deepEqual(malformedJobs, [])
  assert.deepEqual(malformedJobs.flatMap((job) => job.assetIds.map((assetId) => assetDetailHref(assetId))), [])
  assert.deepEqual(extractMediaJobs({ content: 'not json {' }), [])
})

test('UUID and URL safety helpers validate strictly', () => {
  assert.equal(isValidUuid('00000000-0000-4000-8000-000000000201'), true)
  assert.equal(isValidUuid('not-a-uuid'), false)
  assert.equal(shortUuid('00000000-0000-4000-8000-000000000201'), '#00000000')
  assert.equal(shortUuid(null), '—')

  assert.equal(isSafeDisplayUrl('/showcase/a.webp'), true)
  assert.equal(isSafeDisplayUrl('https://cdn.example.com/a.png'), true)
  assert.equal(isSafeDisplayUrl('blob:https://app.example.com/123'), true)
  assert.equal(isSafeDisplayUrl('data:image/png;base64,AAA'), true)
  assert.equal(isSafeDisplayUrl('//evil.example.com/x.png'), false)
  assert.equal(isSafeDisplayUrl('/\\evil.example.com/x.png'), false)
  assert.equal(isSafeDisplayUrl('javascript:alert(1)'), false)
  assert.equal(isSafeDisplayUrl(null), false)
})
