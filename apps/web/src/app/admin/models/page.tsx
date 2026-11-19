import type { Metadata } from 'next'

import { AdminModelsView } from '@/features/admin/components/admin-models-view'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '模型配置',
  description: '管理图像、视频与语言模型接入、并发上限、凭据关联及默认生成模型。',
}

export default function AdminModelsPage() {
  return <AdminModelsView />
}
