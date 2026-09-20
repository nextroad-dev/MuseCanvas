import { AdminBillingView } from '@/features/admin/components/admin-billing-view'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '计费设置 - MuseCanvas 管理后台',
}

export default function AdminBillingPage() {
  return <AdminBillingView />
}
