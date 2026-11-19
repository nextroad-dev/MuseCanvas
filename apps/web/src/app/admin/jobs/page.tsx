import type { Metadata } from 'next'

import { AdminJobsView } from '@/features/admin/components/admin-jobs-view'

export const metadata: Metadata = {
  title: '任务审计日志',
  description: '按状态、模型、用户与日期筛选全站生成任务，排查异常错误码与供应商遥测数据。',
}

export default function AdminJobsPage() {
  return <AdminJobsView />
}
