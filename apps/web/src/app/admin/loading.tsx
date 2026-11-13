import { AdminDashboardSkeleton } from './_components/admin-dashboard-skeleton'

/** `/admin` 路由段加载态：外壳（layout）已渲染，这里只占内容区。 */
export default function AdminLoading() {
  return <AdminDashboardSkeleton />
}
