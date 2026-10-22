import { AdminPageSkeleton } from '../_components/admin-page-skeleton'

export default function Loading() {
  return <AdminPageSkeleton title="任务监控" description="全系统生成任务状态与已有错误摘要；不提供未经接口支持的进度百分比。" variant="list" />
}
