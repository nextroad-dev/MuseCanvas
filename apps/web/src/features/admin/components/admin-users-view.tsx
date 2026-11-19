'use client'

import { useMemo, useState } from 'react'
import {
  ArrowClockwiseIcon,
  CaretLeftIcon,
  CaretRightIcon,
  MagnifyingGlassIcon,
  ProhibitIcon,
  TrashIcon,
  UserCheckIcon,
  XIcon,
} from '@phosphor-icons/react'

import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Input,
  PageHeader,
  SegmentedControl,
  Skeleton,
  TableBody,
  TableCell,
  TableHeadCell,
  TableHeader,
  TableRow,
  TableSkeletonRow,
  TableStateRow,
  ghostIconButtonVariants,
  iconSize,
  useToast,
} from '@/shared/components/ui'
import {
  useAdminUsers,
  useDeleteAdminUser,
  useSetAdminUserStatus,
} from '@/shared/hooks/useAdmin'
import { useSession } from '@/shared/hooks/useSession'
import { formatCount, formatDateTime } from '@/shared/lib/format'
import type { AdminUserDto } from '@/shared/types'
import { adminErrorMessage } from '../lib/admin-settings-api-error'

type StatusFilter = 'all' | 'active' | 'disabled'

const PAGE_LIMIT = 20
const TABLE_COLUMNS = 5

const STATUS_ITEMS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '正常' },
  { value: 'disabled', label: '已停用' },
]

type PendingConfirm =
  | { kind: 'disable'; user: AdminUserDto }
  | { kind: 'delete'; user: AdminUserDto }
  | null

export function AdminUsersView() {
  const { toast } = useToast()
  const sessionQuery = useSession()
  const currentUserId = sessionQuery.data?.user.id ?? ''

  const [emailInput, setEmailInput] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [cursorStack, setCursorStack] = useState<string[]>([])
  const [confirmState, setConfirmState] = useState<PendingConfirm>(null)
  const [enablingUserId, setEnablingUserId] = useState<string | null>(null)

  const currentCursor = cursorStack[cursorStack.length - 1]
  const trimmedEmail = emailInput.trim()

  const filters = useMemo(
    () => ({
      limit: PAGE_LIMIT,
      ...(currentCursor ? { cursor: currentCursor } : {}),
      ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
      ...(trimmedEmail ? { email: trimmedEmail } : {}),
    }),
    [currentCursor, statusFilter, trimmedEmail],
  )

  const usersQuery = useAdminUsers(filters)
  const setStatusMutation = useSetAdminUserStatus()
  const deleteUserMutation = useDeleteAdminUser()

  const users = usersQuery.data?.items ?? []
  const total = usersQuery.data?.total ?? 0
  const hasMore = Boolean(usersQuery.data?.hasMore && usersQuery.data?.nextCursor)
  const pageNumber = cursorStack.length + 1

  function handleEmailChange(value: string) {
    setEmailInput(value)
    setCursorStack([])
  }

  function handleStatusFilterChange(next: StatusFilter) {
    setStatusFilter(next)
    setCursorStack([])
  }

  function handleEnableUser(user: AdminUserDto) {
    setEnablingUserId(user.id)
    setStatusMutation.mutate(
      { id: user.id, status: 'active' },
      {
        onSuccess: () => {
          toast.success('账号已启用', `${user.email} 已恢复正常访问权限。`)
        },
        onError: (error) => {
          toast.error('启用账号失败', adminErrorMessage(error))
        },
        onSettled: () => {
          setEnablingUserId(null)
        },
      },
    )
  }

  function handleConfirmAction() {
    if (!confirmState) return
    if (confirmState.kind === 'disable') {
      const target = confirmState.user
      setStatusMutation.mutate(
        { id: target.id, status: 'disabled' },
        {
          onSuccess: () => {
            toast.success('账号已停用', `${target.email} 的会话与登录权限已被冻结。`)
            setConfirmState(null)
          },
          onError: (error) => {
            toast.error('停用账号失败', adminErrorMessage(error))
          },
        },
      )
      return
    }

    const target = confirmState.user
    deleteUserMutation.mutate(target.id, {
      onSuccess: () => {
        toast.success('用户已删除', `${target.email} 及其关联会话已移除。`)
        setConfirmState(null)
      },
      onError: (error) => {
        toast.error('删除用户失败', adminErrorMessage(error))
      },
    })
  }

  const confirmBusy = setStatusMutation.isPending || deleteUserMutation.isPending

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="用户管理"
        description="检索站点注册用户，管理账号启用/停用状态或彻底清理违规账户。"
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void usersQuery.refetch()}
            loading={usersQuery.isFetching}
            leadingIcon={<ArrowClockwiseIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
          >
            刷新
          </Button>
        }
      />

      {/* Toolbar */}
      <Card density="none" className="flex flex-wrap items-center justify-between gap-3 border border-border p-4">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
          <div className="relative w-full sm:max-w-xs">
            <MagnifyingGlassIcon
              weight="regular"
              aria-hidden="true"
              className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground ${iconSize.sm}`}
            />
            <Input
              type="search"
              value={emailInput}
              onChange={(event) => handleEmailChange(event.target.value)}
              placeholder="按邮箱搜索用户…"
              aria-label="按邮箱搜索用户"
              className="pl-9 pr-8"
            />
            {emailInput ? (
              <button
                type="button"
                onClick={() => handleEmailChange('')}
                aria-label="清空邮箱搜索"
                className={`absolute right-1.5 top-1/2 -translate-y-1/2 ${ghostIconButtonVariants({ size: 'xs' })}`}
              >
                <XIcon weight="bold" aria-hidden="true" className={iconSize.xs} />
              </button>
            ) : null}
          </div>

          <SegmentedControl
            label="按账号状态筛选"
            items={STATUS_ITEMS}
            value={statusFilter}
            onChange={handleStatusFilterChange}
          />
        </div>

        <div className="flex items-center gap-2">
          <Badge tone="neutral" className="font-mono tabular-nums">
            共 {usersQuery.isPending ? '…' : formatCount(total)} 位用户
          </Badge>
        </div>
      </Card>

      {usersQuery.isError ? (
        <Alert
          tone="danger"
          title="用户列表加载失败"
          action={
            <Button variant="secondary" size="sm" onClick={() => void usersQuery.refetch()}>
              重试
            </Button>
          }
        >
          {adminErrorMessage(usersQuery.error)}
        </Alert>
      ) : null}

      {/* DataTable */}
      <DataTable
        caption="站点注册用户列表"
        columns={TABLE_COLUMNS}
        className="[&>table]:min-w-[760px]"
      >
        <TableHeader>
          <TableHeadCell>邮箱</TableHeadCell>
          <TableHeadCell>角色</TableHeadCell>
          <TableHeadCell>状态</TableHeadCell>
          <TableHeadCell>注册时间</TableHeadCell>
          <TableHeadCell align="right">操作</TableHeadCell>
        </TableHeader>
        <TableBody busy={usersQuery.isFetching}>
          {usersQuery.isPending ? (
            Array.from({ length: 6 }, (_, index) => (
              <TableSkeletonRow
                key={index}
                cells={[
                  <div key="email" className="flex items-center gap-3">
                    <Skeleton className="size-8 rounded-pill" />
                    <Skeleton className="h-4 w-48" />
                  </div>,
                  <Skeleton key="role" className="h-5 w-16" />,
                  <Skeleton key="status" className="h-5 w-16" />,
                  <Skeleton key="created" className="h-4 w-32" />,
                  <Skeleton key="actions" className="ml-auto h-8 w-28" />,
                ]}
              />
            ))
          ) : users.length === 0 ? (
            <TableStateRow>
              <EmptyState
                density="compact"
                title={trimmedEmail || statusFilter !== 'all' ? '没有匹配筛选条件的用户' : '暂无用户数据'}
                description={
                  trimmedEmail || statusFilter !== 'all'
                    ? '请尝试调整搜索邮箱关键词或切换账号状态筛选。'
                    : '站点还没有注册用户。'
                }
                action={
                  trimmedEmail || statusFilter !== 'all' ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setEmailInput('')
                        setStatusFilter('all')
                        setCursorStack([])
                      }}
                    >
                      重置筛选
                    </Button>
                  ) : undefined
                }
              />
            </TableStateRow>
          ) : (
            users.map((user) => {
              const isSelf = Boolean(currentUserId && user.id === currentUserId)
              const isActive = user.status === 'active'
              const isEnabling = enablingUserId === user.id && setStatusMutation.isPending

              return (
                <TableRow key={user.id} hover>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar size="sm" initial={user.email} decorative />
                      <div className="flex min-w-0 flex-col">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate font-medium text-foreground">{user.email}</span>
                          {isSelf ? <Badge tone="info">当前账号</Badge> : null}
                        </div>
                        <span className="truncate font-mono text-caption text-muted-foreground" title={user.id}>
                          ID: {user.id}
                        </span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge tone={user.role === 'admin' ? 'info' : 'neutral'}>
                      {user.role === 'admin' ? '管理员' : '普通用户'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge tone={isActive ? 'success' : 'danger'} dot>
                      {isActive ? '正常' : '已停用'}
                    </Badge>
                  </TableCell>
                  <TableCell mono tabular tone="muted">
                    <time dateTime={user.createdAt}>{formatDateTime(user.createdAt)}</time>
                  </TableCell>
                  <TableCell align="right">
                    <div className="inline-flex flex-wrap items-center justify-end gap-2">
                      {isSelf ? (
                        <span className="mr-1 text-caption text-muted-foreground">自我保护已启用</span>
                      ) : null}
                      {isActive ? (
                        <Button
                          variant="secondary"
                          size="xs"
                          disabled={isSelf}
                          title={isSelf ? '不能停用当前登录的管理员账号' : `停用 ${user.email}`}
                          leadingIcon={<ProhibitIcon weight="regular" aria-hidden="true" className={iconSize.xs} />}
                          onClick={() => setConfirmState({ kind: 'disable', user })}
                        >
                          停用
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          size="xs"
                          loading={isEnabling}
                          disabled={isSelf || isEnabling}
                          title={`启用 ${user.email}`}
                          leadingIcon={<UserCheckIcon weight="regular" aria-hidden="true" className={iconSize.xs} />}
                          onClick={() => handleEnableUser(user)}
                        >
                          启用
                        </Button>
                      )}

                      <Button
                        variant="danger-ghost"
                        size="xs"
                        disabled={isSelf}
                        title={isSelf ? '不能删除当前登录的管理员账号' : `删除 ${user.email}`}
                        leadingIcon={<TrashIcon weight="regular" aria-hidden="true" className={iconSize.xs} />}
                        onClick={() => setConfirmState({ kind: 'delete', user })}
                      >
                        删除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </DataTable>

      {/* Cursor Pagination */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-mono text-xs tabular-nums text-muted-foreground">
          第 {pageNumber} 页 · 当前显示 {users.length} / {formatCount(total)} 条
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={cursorStack.length === 0 || usersQuery.isFetching}
            leadingIcon={<CaretLeftIcon weight="bold" aria-hidden="true" className={iconSize.xs} />}
            onClick={() => setCursorStack((prev) => prev.slice(0, -1))}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasMore || usersQuery.isFetching}
            trailingIcon={<CaretRightIcon weight="bold" aria-hidden="true" className={iconSize.xs} />}
            onClick={() => {
              const nextCursor = usersQuery.data?.nextCursor
              if (nextCursor) {
                setCursorStack((prev) => [...prev, nextCursor])
              }
            }}
          >
            下一页
          </Button>
        </div>
      </div>

      {/* Confirmation Dialog */}
      <Dialog
        open={confirmState !== null}
        onClose={() => {
          if (!confirmBusy) setConfirmState(null)
        }}
        title={confirmState?.kind === 'delete' ? '确认删除用户' : '确认停用用户'}
        description={
          confirmState?.kind === 'delete'
            ? '删除操作不可撤销，该用户的会话及账户记录将被永久移除。'
            : '停用后，该用户将立即失去登录与提交生成任务的权限，可随时重新启用。'
        }
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={confirmBusy}
              onClick={() => setConfirmState(null)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={confirmBusy}
              onClick={handleConfirmAction}
            >
              {confirmState?.kind === 'delete' ? '确认删除' : '确认停用'}
            </Button>
          </>
        }
      >
        {confirmState ? (
          <div className="flex flex-col gap-2 rounded-control border border-border bg-canvas p-3.5 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">目标邮箱</span>
              <span className="font-medium text-foreground">{confirmState.user.email}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">用户 ID</span>
              <span className="font-mono text-xs text-muted-foreground">{confirmState.user.id}</span>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  )
}
