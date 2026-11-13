import type { Metadata } from 'next'
import { AdminOAuthView } from '@/features/admin/components/admin-oauth-view'

export const metadata: Metadata = {
  title: 'OAuth 登录',
  description: '管理 GitHub / Google 第三方登录凭据、回调地址与启停状态。',
}

/** 后台 OAuth 页（A1 壳提供守卫与页面框架，页面只渲染内容）。 */
export default function AdminOAuthPage() {
  return <AdminOAuthView />
}
