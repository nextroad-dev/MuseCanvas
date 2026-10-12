'use client'

import type { AdminJob } from '@/shared/types'
import { Badge } from '@/shared/components/ui'
import { formatLocalizedDateTime } from '@/shared/lib/format'
import { jobStatusMeta } from '@/shared/lib/job-status'
import { adminJobDetailValues } from '../lib/admin-query'
import { AdminRecordFields } from './admin-record-detail-dialog'
import { AdminCopyValue } from './admin-copy-value'

/** Explicit whitelist shared by recent-job and monitor details, never raw provider data. */
export function AdminJobDetail({ job }: { job: AdminJob }) {
  const values = adminJobDetailValues(job)
  const status = jobStatusMeta(values.status)
  return <AdminRecordFields fields={[
    { label: '任务 ID', value: <AdminCopyValue value={values.id} label="完整任务 ID" /> },
    { label: '创建者 ID', value: <span className="font-mono">{values.createdBy}</span> },
    { label: '模型', value: values.modelName },
    { label: '模型 ID', value: <span className="font-mono">{values.modelId}</span> },
    { label: '状态', value: <Badge className={status.badge}>{status.label}</Badge> },
    { label: '错误摘要', value: values.errorSummary },
    { label: '创建时间', value: formatLocalizedDateTime(values.createdAt) },
  ]} />
}
