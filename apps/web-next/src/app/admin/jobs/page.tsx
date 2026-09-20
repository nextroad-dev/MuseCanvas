import { AdminJobsView } from '@/features/admin/components/admin-jobs-view'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '任务监控 - MuseCanvas 管理后台',
}

export default function AdminJobsPage() {
  return <AdminJobsView />
}
