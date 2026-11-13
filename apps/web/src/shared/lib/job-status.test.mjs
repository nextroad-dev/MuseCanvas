import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ACTIVE_JOB_STATUSES,
  isJobActive,
  isJobTerminal,
  jobStatusLabel,
  jobStatusMeta,
  jobStatusTone,
  phaseLabel,
  phaseTone,
} from './job-status.ts'

test('进行中状态的判定只覆盖 queued/running/retry_wait', () => {
  assert.deepEqual([...ACTIVE_JOB_STATUSES], ['queued', 'running', 'retry_wait'])
  for (const status of ['queued', 'running', 'retry_wait']) {
    assert.equal(isJobActive({ status }), true)
    assert.equal(isJobTerminal(status), false)
  }
  for (const status of ['succeeded', 'failed', 'canceled']) {
    assert.equal(isJobActive({ status }), false)
    assert.equal(isJobTerminal(status), true)
  }
})

test('每个状态都有中文 label 与语气，未知状态回落到中性', () => {
  assert.equal(jobStatusLabel('queued'), '排队中')
  assert.equal(jobStatusLabel('running'), '生成中')
  assert.equal(jobStatusLabel('retry_wait'), '重试等待')
  assert.equal(jobStatusLabel('succeeded'), '已完成')
  assert.equal(jobStatusLabel('failed'), '失败')
  assert.equal(jobStatusLabel('canceled'), '已取消')
  assert.equal(jobStatusLabel('mystery'), '未知状态')
  assert.equal(jobStatusTone('succeeded'), 'success')
  assert.equal(jobStatusTone('failed'), 'danger')
  assert.equal(jobStatusTone('canceled'), 'neutral')
  assert.equal(jobStatusTone('mystery'), 'neutral')
  assert.deepEqual(jobStatusMeta('running'), { label: '生成中', tone: 'info' })
})

test('阶段文案由 phase 映射，未知/缺失回落准备中', () => {
  assert.equal(phaseLabel('prompt_optimizing'), '优化提示词')
  assert.equal(phaseLabel('provider_waiting'), '等待返回')
  assert.equal(phaseLabel('image_generating'), '生成图像')
  assert.equal(phaseLabel('completed'), '已完成')
  assert.equal(phaseLabel(null), '准备中')
  assert.equal(phaseLabel('unknown-phase'), '准备中')
  assert.equal(phaseTone('generation_failed'), 'danger')
  assert.equal(phaseTone('completed'), 'success')
  assert.equal(phaseTone(undefined), 'neutral')
})
