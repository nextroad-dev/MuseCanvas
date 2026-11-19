import type { Metadata } from 'next'

import { AdminProvidersView } from '@/features/admin/components/admin-providers-view'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '供应商凭据',
  description: '集中管理外部模型供应商 API 密钥与接口地址，支持实时连通性探测。',
}

export default function AdminProvidersPage() {
  return <AdminProvidersView />
}
