import { AdminPageSkeleton } from '../_components/admin-page-skeleton'

export default function Loading() {
  return <AdminPageSkeleton title="用户与邀请管理" description="查看注册用户、角色与账号状态，创建和查看邀请码；本页不修改用户角色或账号状态。" variant="list" />
}
