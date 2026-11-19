'use client'

import { useMemo, useState } from 'react'
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  CaretLeftIcon,
  CaretRightIcon,
  EyeIcon,
  ListChecksIcon,
} from '@phosphor-icons/react'

import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
  TableBody,
  TableCell,
  TableHeadCell,
  TableHeader,
  TableRow,
  TableSkeletonRow,
  TableStateRow,
  iconSize,
} from '@/shared/components/ui'
import { useAdminJobs, useAdminModels } from '@/shared/hooks/useAdmin'
import { formatCount, formatDateTime } from '@/shared/lib/format'
import { jobStatusLabel, jobStatusTone, phaseLabel, phaseTone } from '@/shared/lib/job-status'
import type { AdminJobDto, JobStatus } from '@/shared/types'
import { adminErrorMessage } from '../lib/admin-settings-api-error'

const PAGE_LIMIT = 20
const TABLE_COLUMNS = 7

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'queued', label: `${jobStatusLabel('queued')} (queued)` },
  { value: 'running', label: `${jobStatusLabel('running')} (running)` },
  { value: 'retry_wait', label: `${jobStatusLabel('retry_wait')} (retry_wait)` },
  { value: 'succeeded', label: `${jobStatusLabel('succeeded')} (succeeded)` },
  { value: 'failed', label: `${jobStatusLabel('failed')} (failed)` },
  { value: 'canceled', label: `${jobStatusLabel('canceled')} (canceled)` },
]

function truncateId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

function mediaKindLabel(kind: string): string {
  if (kind === 'image') return '图像'
  if (kind === 'video') return '视频'
  return kind || '—'
}

function formatDurationMs(durationMs?: number): string {
  if (durationMs === undefined || durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return '—'
  }
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`
  return `${(durationMs / 1000).toFixed(1)} s`
}

function TelemetryField({
  label,
  value,
  mono = false,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="flex flex-col gap-1 rounded-control border border-border bg-canvas px-3.5 py-2.5">
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className={mono ? 'break-all font-mono text-xs tabular-nums text-foreground' : 'text-sm text-foreground'}>
        {value ?? '—'}
      </dd>
    </div>
  )
}

export function AdminJobsView() {
  const [status, setStatus] = useState('')
  const [modelId, setModelId] = useState('')
  const [userId, setUserId] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [cursorStack, setCursorStack] = useState<string[]>([])
  const [selectedJob, setSelectedJob] = useState<AdminJobDto | null>(null)

  const currentCursor = cursorStack[cursorStack.length - 1]
  const trimmedUserId = userId.trim()

  const filters = useMemo(
    () => ({
      limit: PAGE_LIMIT,
      ...(currentCursor ? { cursor: currentCursor } : {}),
      ...(status ? { status } : {}),
      ...(modelId ? { modelId } : {}),
      ...(trimmedUserId ? { userId: trimmedUserId } : {}),
      ...(fromDate ? { from: fromDate } : {}),
      ...(toDate ? { to: toDate } : {}),
    }),
    [currentCursor, status, modelId, trimmedUserId, fromDate, toDate],
  )

  const jobsQuery = useAdminJobs(filters)
  const modelsQuery = useAdminModels()

  const jobs = jobsQuery.data?.items ?? []
  const total = jobsQuery.data?.total ?? 0
  const hasMore = Boolean(jobsQuery.data?.hasMore && jobsQuery.data?.nextCursor)
  const pageNumber = cursorStack.length + 1

  const mediaModels = useMemo(
    () => (modelsQuery.data ?? []).filter((m) => m.modelKind === 'image' || m.modelKind === 'video'),
    [modelsQuery.data],
  )

  const hasActiveFilters = Boolean(status || modelId || trimmedUserId || fromDate || toDate)

  function resetFilters() {
    setStatus('')
    setModelId('')
    setUserId('')
    setFromDate('')
    setToDate('')
    setCursorStack([])
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="任务审计日志"
        description="按状态、模型、用户 ID 与时间区间检索全站生成任务，排查异常错误码与供应商遥测数据。"
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void jobsQuery.refetch()}
            loading={jobsQuery.isFetching}
            leadingIcon={<ArrowClockwiseIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
          >
            刷新
          </Button>
        }
      />

      {/* Filter Bar */}
      <Card density="none" className="flex flex-col gap-4 border border-border p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="任务状态">
            <Select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value)
                setCursorStack([])
              }}
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value || 'all'} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="生成模型">
            <Select
              value={modelId}
              onChange={(event) => {
                setModelId(event.target.value)
                setCursorStack([])
              }}
            >
              <option value="">全部模型</option>
              {mediaModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName} ({mediaKindLabel(model.modelKind)})
                </option>
              ))}
            </Select>
          </Field>

          <Field label="用户 ID (UUID)">
            <Input
              value={userId}
              onChange={(event) => {
                setUserId(event.target.value)
                setCursorStack([])
              }}
              placeholder="输入用户 UUID…"
              className="font-mono text-xs"
            />
          </Field>

          <Field label="起始日期">
            <Input
              type="date"
              value={fromDate}
              onChange={(event) => {
                setFromDate(event.target.value)
                setCursorStack([])
              }}
              className="font-mono text-xs"
            />
          </Field>

          <Field label="截止日期">
            <Input
              type="date"
              value={toDate}
              onChange={(event) => {
                setToDate(event.target.value)
                setCursorStack([])
              }}
              className="font-mono text-xs"
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <Badge tone="neutral" className="font-mono tabular-nums">
            共 {jobsQuery.isPending ? '…' : formatCount(total)} 条任务记录
          </Badge>

          <Button
            variant="ghost"
            size="sm"
            disabled={!hasActiveFilters}
            leadingIcon={<ArrowCounterClockwiseIcon weight="regular" aria-hidden="true" className={iconSize.sm} />}
            onClick={resetFilters}
          >
            重置筛选
          </Button>
        </div>
      </Card>

      {jobsQuery.isError ? (
        <Alert
          tone="danger"
          title="任务审计日志加载失败"
          action={
            <Button variant="secondary" size="sm" onClick={() => void jobsQuery.refetch()}>
              重试
            </Button>
          }
        >
          {adminErrorMessage(jobsQuery.error)}
        </Alert>
      ) : null}

      {/* Data Table */}
      <DataTable
        caption="生成任务审计列表"
        columns={TABLE_COLUMNS}
        className="[&>table]:min-w-[860px]"
      >
        <TableHeader>
          <TableHeadCell>任务 ID</TableHeadCell>
          <TableHeadCell>模型 & 媒体类型</TableHeadCell>
          <TableHeadCell>状态</TableHeadCell>
          <TableHeadCell>耗时</TableHeadCell>
          <TableHeadCell>错误码</TableHeadCell>
          <TableHeadCell>创建时间</TableHeadCell>
          <TableHeadCell align="right">操作</TableHeadCell>
        </TableHeader>
        <TableBody busy={jobsQuery.isFetching}>
          {jobsQuery.isPending ? (
            Array.from({ length: 6 }, (_, index) => (
              <TableSkeletonRow
                key={index}
                cells={[
                  <Skeleton key="id" className="h-4 w-20" />,
                  <Skeleton key="model" className="h-5 w-40" />,
                  <Skeleton key="status" className="h-5 w-16" />,
                  <Skeleton key="duration" className="h-4 w-16" />,
                  <Skeleton key="error" className="h-4 w-24" />,
                  <Skeleton key="created" className="h-4 w-32" />,
                  <Skeleton key="actions" className="ml-auto h-8 w-16" />,
                ]}
              />
            ))
          ) : jobs.length === 0 ? (
            <TableStateRow>
              <EmptyState
                density="compact"
                icon={ListChecksIcon}
                title={hasActiveFilters ? '没有符合筛选条件的任务' : '暂无任务记录'}
                description={
                  hasActiveFilters
                    ? '请尝试放宽状态、模型、用户 ID 或日期筛选范围。'
                    : '当用户提交图像或视频生成请求后，任务审计记录将显示在此处。'
                }
                action={
                  hasActiveFilters ? (
                    <Button variant="secondary" size="sm" onClick={resetFilters}>
                      重置筛选
                    </Button>
                  ) : undefined
                }
              />
            </TableStateRow>
          ) : (
            jobs.map((job) => (
              <TableRow key={job.id} hover>
                <TableCell mono tabular title={job.id}>
                  {truncateId(job.id)}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{job.modelName || job.modelId || '—'}</span>
                    <Badge tone="neutral">{mediaKindLabel(job.mediaKind)}</Badge>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge tone={jobStatusTone(job.status as JobStatus)} dot>
                    {jobStatusLabel(job.status as JobStatus)}
                  </Badge>
                </TableCell>
                <TableCell mono tabular tone="muted">
                  {formatDurationMs(job.durationMs)}
                </TableCell>
                <TableCell mono>
                  {job.errorCode ? (
                    <Badge tone="danger" className="font-mono">
                      {job.errorCode}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell mono tabular tone="muted">
                  <time dateTime={job.createdAt}>{formatDateTime(job.createdAt)}</time>
                </TableCell>
                <TableCell align="right">
                  <Button
                    variant="secondary"
                    size="xs"
                    leadingIcon={<EyeIcon weight="regular" aria-hidden="true" className={iconSize.xs} />}
                    onClick={() => setSelectedJob(job)}
                  >
                    详情
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </DataTable>

      {/* Cursor Pagination */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-mono text-xs tabular-nums text-muted-foreground">
          第 {pageNumber} 页 · 当前显示 {jobs.length} / {formatCount(total)} 条
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={cursorStack.length === 0 || jobsQuery.isFetching}
            leadingIcon={<CaretLeftIcon weight="bold" aria-hidden="true" className={iconSize.xs} />}
            onClick={() => setCursorStack((prev) => prev.slice(0, -1))}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasMore || jobsQuery.isFetching}
            trailingIcon={<CaretRightIcon weight="bold" aria-hidden="true" className={iconSize.xs} />}
            onClick={() => {
              const nextCursor = jobsQuery.data?.nextCursor
              if (nextCursor) {
                setCursorStack((prev) => [...prev, nextCursor])
              }
            }}
          >
            下一页
          </Button>
        </div>
      </div>

      {/* Wide Job Detail Telemetry Dialog */}
      <Dialog
        open={selectedJob !== null}
        onClose={() => setSelectedJob(null)}
        size="wide"
        title="任务遥测详情"
        description={selectedJob ? `任务 ID：${selectedJob.id}` : undefined}
        footer={
          <Button variant="secondary" size="sm" onClick={() => setSelectedJob(null)}>
            关闭
          </Button>
        }
      >
        {selectedJob ? (
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TelemetryField label="任务 ID (id)" value={selectedJob.id} mono />
              <TelemetryField label="创建用户 (createdBy)" value={selectedJob.createdBy} mono />
              <TelemetryField
                label="模型与媒体类型"
                value={
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <span className="font-medium">{selectedJob.modelName || selectedJob.modelId}</span>
                    <Badge tone="neutral">{mediaKindLabel(selectedJob.mediaKind)}</Badge>
                  </span>
                }
              />
              <TelemetryField
                label="任务状态与阶段"
                value={
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Badge tone={jobStatusTone(selectedJob.status)} dot>
                      {jobStatusLabel(selectedJob.status)}
                    </Badge>
                    {selectedJob.phase ? (
                      <Badge tone={phaseTone(selectedJob.phase)}>
                        {phaseLabel(selectedJob.phase)} ({selectedJob.phase})
                      </Badge>
                    ) : null}
                  </span>
                }
              />
              <TelemetryField label="执行耗时 (durationMs)" value={formatDurationMs(selectedJob.durationMs)} mono />
              <TelemetryField label="提示词模板 (templateName)" value={selectedJob.templateName || '未使用'} />
              <TelemetryField
                label="语言模型 / 协议"
                value={
                  selectedJob.languageModelName
                    ? `${selectedJob.languageModelName}${
                        selectedJob.languageModelProtocol ? ` (${selectedJob.languageModelProtocol})` : ''
                      }`
                    : '未启用提示词优化'
                }
              />
              <TelemetryField
                label="错误码 (errorCode)"
                value={
                  selectedJob.errorCode ? (
                    <Badge tone="danger" className="font-mono">
                      {selectedJob.errorCode}
                    </Badge>
                  ) : (
                    '无'
                  )
                }
              />
              <TelemetryField
                label="供应商引用 ID (providerReferenceId)"
                value={
                  selectedJob.providerReferenceId ||
                  selectedJob.providerError?.providerReferenceId ||
                  '—'
                }
                mono
              />
              <TelemetryField
                label="插件 / 供应商标识"
                value={
                  selectedJob.pluginId
                    ? `${selectedJob.pluginId}${selectedJob.pluginVersion ? `@${selectedJob.pluginVersion}` : ''}`
                    : selectedJob.providerId || '—'
                }
                mono
              />
              <TelemetryField label="创建时间 (createdAt)" value={formatDateTime(selectedJob.createdAt)} mono />
              <TelemetryField
                label="完成时间 (completedAt)"
                value={selectedJob.completedAt ? formatDateTime(selectedJob.completedAt) : '—'}
                mono
              />
            </dl>

            <div className="flex flex-col gap-1.5">
              <span className="text-caption font-medium text-muted-foreground">
                供应商错误遥测 (providerError)
              </span>
              {selectedJob.providerError ? (
                <pre className="max-h-60 overflow-auto rounded-control border border-border bg-canvas p-3.5 font-mono text-xs leading-relaxed text-foreground">
                  {JSON.stringify(selectedJob.providerError, null, 2)}
                </pre>
              ) : (
                <div className="rounded-control border border-border bg-canvas px-3.5 py-3 font-mono text-xs text-muted-foreground">
                  无供应商错误载荷
                </div>
              )}
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  )
}
