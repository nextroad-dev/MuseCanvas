import { AdminPageSkeleton } from '../_components/admin-page-skeleton'

export default function Loading() {
  return <AdminPageSkeleton title="OAuth 登录提供商" description="查看第三方登录配置并管理启停。提供商凭据由初始化流程或服务端环境配置，后台不提供编辑表单。" variant="oauth" />
}
