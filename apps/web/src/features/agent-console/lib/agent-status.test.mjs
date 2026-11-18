import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AGENT_MESSAGE_MAX_BYTES,
  deriveSessionStatus,
  extractArtifactPreview,
  extractItemText,
  extractToolPayloadInfo,
  formatAgentErrorCode,
  formatApprovalStatus,
  formatConnectionState,
  formatSessionStatus,
  formatToolStatus,
  formatTurnStatus,
  isMessageOverLimit,
  isSafeDisplayUrl,
  isValidUuid,
  shortUuid,
  utf8ByteLength,
} from './agent-status.ts'

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
