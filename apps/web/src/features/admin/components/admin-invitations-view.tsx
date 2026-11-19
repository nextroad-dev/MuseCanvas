'use client'

import { useState } from 'react'
import {
  ArrowClockwiseIcon,
  CheckIcon,
  CopyIcon,
  PlusIcon,
  ProhibitIcon,
  ShieldCheckIcon,
  TicketIcon,
} from '@phosphor-icons/react'

import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
  DataTable,
  Dialog,
  EmptyState,
  PageHeader,
  SectionHeader,
  Skeleton,
  Switch,
  TableBody,
  TableCell,
  TableHeadCell,
  TableHeader,
  TableRow,
  TableSkeletonRow,
  TableStateRow,
  controlSquare,
  iconSize,
  useToast,
} from '@/shared/components/ui'
import {
  useAdminInvitations,
  useAdminRegistration,
  useCreateAdminInvitation,
  useRevokeAdminInvitation,
  useSetAdminRegistration,
} from '@/shared/hooks/useAdmin'
import { cn } from '@/shared/lib/cn'
import { formatCount, formatDateTime } from '@/shared/lib/format'
import type { InvitationDto } from '@/shared/types'
import { adminErrorMessage } from '../lib/admin-settings-api-error'

const TABLE_COLUMNS = 4

function invitationStatusMeta(invitation: InvitationDto): {
  label: string
  tone: 'success' | 'neutral' | 'danger'
} {
  if (invitation.revoked) {
    return { label: '已撤销', tone: 'danger' }
  }
  if (invitation.used) {
    return { label: '已使用', tone: 'neutral' }
  }
  return { label: '可用', tone: 'success' }
}

export function AdminInvitationsView() {
  const { toast } = useToast()

  const registrationQuery = useAdminRegistration()
  const setRegistrationMutation = useSetAdminRegistration()

  const invitationsQuery = useAdminInvitations()
  const createInvitationMutation = useCreateAdminInvitation()
  const revokeInvitationMutation = useRevokeAdminInvitation()

  const [latestCreated, setLatestCreated] = useState<InvitationDto | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<InvitationDto | null>(null)

  const requiresInvitation = Boolean(registrationQuery.data?.requiresInvitation)
  const invitations = invitationsQuery.data?.items ?? []
  const total = invitationsQuery.data?.total ?? invitations.length

  async function handleCopyCode(code: string, key: string) {
    try {
      await navigator.clipboard.writeText(code)
      setCopiedKey(key)
      toast.success('邀请码已复制', code)
      window.setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current))
      }, 2000)
    } catch {
      toast.error('复制失败', '当前浏览器环境不支持自动写入剪贴板，请手动选中复制。')
    }
  }

  function handleToggleRegistration(nextRequiresInvitation: boolean) {
    setRegistrationMutation.mutate(nextRequiresInvitation, {
      onSuccess: (saved) => {
        toast.success(
          saved.requiresInvitation ? '已开启邀请制注册' : '已切换为开放注册',
          saved.requiresInvitation
            ? '新用户注册时必须提供一枚有效且未撤销的邀请码。'
            : '新用户可通过邮箱验证码或 OAuth 直接注册。',
        )
      },
      onError: (error) => {
        toast.error('更新注册模式失败', adminErrorMessage(error))
      },
    })
  }

  function handleCreateInvitation() {
    createInvitationMutation.mutate(undefined, {
      onSuccess: (created) => {
        setLatestCreated(created)
        toast.success('已生成新邀请码', created.code ? `邀请码：${created.code}` : '可在下方横幅或列表中查看。')
      },
      onError: (error) => {
        toast.error('生成邀请码失败', adminErrorMessage(error))
      },
    })
  }

  function handleConfirmRevoke() {
    if (!revokeTarget) return
    revokeInvitationMutation.mutate(revokeTarget.id, {
      onSuccess: () => {
        toast.success('邀请码已撤销', revokeTarget.code ? `${revokeTarget.code} 已失效。` : '该邀请码已无法用于注册。')
        if (latestCreated?.id === revokeTarget.id) {
          setLatestCreated(null)
        }
        setRevokeTarget(null)
      },
      onError: (error) => {
        toast.error('撤销邀请码失败', adminErrorMessage(error))
      },
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="邀请码管理"
        description="控制站点注册准入模式，签发一次性邀请码并随时撤销尚未使用的凭据。"
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void registrationQuery.refetch()
                void invitationsQuery.refetch()
              }}
              loading={invitationsQuery.isFetching || registrationQuery.isFetching}
              leadingIcon={<ArrowClockwiseIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
            >
              刷新
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleCreateInvitation}
              loading={createInvitationMutation.isPending}
              leadingIcon={<PlusIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
            >
              生成邀请码
            </Button>
          </>
        }
      />

      {/* Registration Mode Switch Card */}
      <Card aria-labelledby="admin-registration-mode-title" className="border border-border">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className={cn(
                  'inline-flex shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent',
                  controlSquare.md,
                )}
              >
                <ShieldCheckIcon weight="duotone" aria-hidden="true" className={iconSize.md} />
              </span>
              <div className="flex flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle id="admin-registration-mode-title" level={2}>
                    注册模式开关
                  </CardTitle>
                  {registrationQuery.isPending ? (
                    <Skeleton className="h-5 w-20" />
                  ) : (
                    <Badge tone={requiresInvitation ? 'info' : 'success'} dot>
                      {requiresInvitation ? '邀请制注册（需要有效邀请码）' : '开放注册'}
                    </Badge>
                  )}
                </div>
                <CardDescription>
                  切换站点新用户准入策略；对已注册用户的登录不受影响。
                </CardDescription>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          {registrationQuery.isError ? (
            <Alert
              tone="danger"
              title="注册模式读取失败"
              action={
                <Button variant="secondary" size="sm" onClick={() => void registrationQuery.refetch()}>
                  重试
                </Button>
              }
            >
              {adminErrorMessage(registrationQuery.error)}
            </Alert>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-control border border-border bg-canvas px-4 py-3.5">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">
                  {requiresInvitation ? '邀请制注册（需要有效邀请码）' : '开放注册'}
                </span>
                <span className="text-xs text-muted-foreground">
                  {requiresInvitation
                    ? '当前仅持有可用邀请码的访客可以完成首次注册。'
                    : '当前允许任何访客通过邮箱 OTP 或已启用的 OAuth 直接创建账号。'}
                </span>
              </div>
              <Switch
                aria-label="邀请制注册（需要有效邀请码）"
                checked={requiresInvitation}
                disabled={registrationQuery.isPending || setRegistrationMutation.isPending}
                onCheckedChange={handleToggleRegistration}
              />
            </div>
          )}
        </CardBody>
      </Card>

      {/* Newly Generated Code Highlight Banner */}
      {latestCreated?.code ? (
        <Alert
          tone="success"
          title="新邀请码已签发"
          onDismiss={() => setLatestCreated(null)}
          action={
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={
                copiedKey === `banner-${latestCreated.id}` ? (
                  <CheckIcon weight="bold" aria-hidden="true" className={iconSize.sm} />
                ) : (
                  <CopyIcon weight="regular" aria-hidden="true" className={iconSize.sm} />
                )
              }
              onClick={() => void handleCopyCode(latestCreated.code ?? '', `banner-${latestCreated.id}`)}
            >
              {copiedKey === `banner-${latestCreated.id}` ? '已复制' : '一键复制'}
            </Button>
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <span>请将此一次性邀请码发送给受邀用户：</span>
            <code className="rounded-control border border-border bg-surface px-2.5 py-0.5 font-mono text-sm font-semibold text-foreground">
              {latestCreated.code}
            </code>
          </div>
        </Alert>
      ) : null}

      {invitationsQuery.isError ? (
        <Alert
          tone="danger"
          title="邀请码列表加载失败"
          action={
            <Button variant="secondary" size="sm" onClick={() => void invitationsQuery.refetch()}>
              重试
            </Button>
          }
        >
          {adminErrorMessage(invitationsQuery.error)}
        </Alert>
      ) : null}

      {/* Invitations Table */}
      <section aria-labelledby="admin-invitations-list-heading" className="flex flex-col gap-3">
        <SectionHeader
          id="admin-invitations-list-heading"
          title="已签发邀请码"
          actions={
            <Badge tone="neutral" className="font-mono tabular-nums">
              共 {invitationsQuery.isPending ? '…' : formatCount(total)} 枚
            </Badge>
          }
        />

        <DataTable
          caption="邀请码列表"
          columns={TABLE_COLUMNS}
          className="[&>table]:min-w-[640px]"
        >
          <TableHeader>
            <TableHeadCell>邀请码</TableHeadCell>
            <TableHeadCell>状态</TableHeadCell>
            <TableHeadCell>创建时间</TableHeadCell>
            <TableHeadCell align="right">操作</TableHeadCell>
          </TableHeader>
          <TableBody busy={invitationsQuery.isFetching}>
            {invitationsQuery.isPending ? (
              Array.from({ length: 5 }, (_, index) => (
                <TableSkeletonRow
                  key={index}
                  cells={[
                    <Skeleton key="code" className="h-5 w-44" />,
                    <Skeleton key="status" className="h-5 w-16" />,
                    <Skeleton key="created" className="h-4 w-32" />,
                    <Skeleton key="actions" className="ml-auto h-8 w-20" />,
                  ]}
                />
              ))
            ) : invitations.length === 0 ? (
              <TableStateRow>
                <EmptyState
                  density="compact"
                  icon={TicketIcon}
                  title="尚未生成任何邀请码"
                  description="点击右上角「生成邀请码」即可签发新的一次性注册邀请凭据。"
                  action={
                    <Button
                      variant="primary"
                      size="sm"
                      loading={createInvitationMutation.isPending}
                      leadingIcon={<PlusIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
                      onClick={handleCreateInvitation}
                    >
                      生成第一枚邀请码
                    </Button>
                  }
                />
              </TableStateRow>
            ) : (
              invitations.map((invitation) => {
                const status = invitationStatusMeta(invitation)
                const canRevoke = !invitation.used && !invitation.revoked
                const copyId = `row-${invitation.id}`
                const isCopied = copiedKey === copyId

                return (
                  <TableRow key={invitation.id} hover>
                    <TableCell mono>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-medium text-foreground">
                          {invitation.code || invitation.id}
                        </span>
                        {invitation.code ? (
                          <Button
                            variant="ghost"
                            size="xs"
                            aria-label={`复制邀请码 ${invitation.code}`}
                            leadingIcon={
                              isCopied ? (
                                <CheckIcon weight="bold" aria-hidden="true" className={iconSize.xs} />
                              ) : (
                                <CopyIcon weight="regular" aria-hidden="true" className={iconSize.xs} />
                              )
                            }
                            onClick={() => void handleCopyCode(invitation.code ?? '', copyId)}
                          >
                            {isCopied ? '已复制' : '复制'}
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge tone={status.tone} dot>
                        {status.label}
                      </Badge>
                    </TableCell>
                    <TableCell mono tabular tone="muted">
                      <time dateTime={invitation.createdAt}>{formatDateTime(invitation.createdAt)}</time>
                    </TableCell>
                    <TableCell align="right">
                      {canRevoke ? (
                        <Button
                          variant="danger-ghost"
                          size="xs"
                          leadingIcon={<ProhibitIcon weight="regular" aria-hidden="true" className={iconSize.xs} />}
                          onClick={() => setRevokeTarget(invitation)}
                        >
                          撤销
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </DataTable>
      </section>

      {/* Revoke Confirmation Dialog */}
      <Dialog
        open={revokeTarget !== null}
        onClose={() => {
          if (!revokeInvitationMutation.isPending) setRevokeTarget(null)
        }}
        title="确认撤销邀请码"
        description="撤销后该邀请码将立即作废，无法再用于新用户注册，且不可恢复。"
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={revokeInvitationMutation.isPending}
              onClick={() => setRevokeTarget(null)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={revokeInvitationMutation.isPending}
              onClick={handleConfirmRevoke}
            >
              确认撤销
            </Button>
          </>
        }
      >
        {revokeTarget ? (
          <div className="flex flex-col gap-2 rounded-control border border-border bg-canvas p-3.5 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">邀请码</span>
              <span className="font-mono text-xs font-semibold text-foreground">
                {revokeTarget.code || revokeTarget.id}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">签发时间</span>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {formatDateTime(revokeTarget.createdAt)}
              </span>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  )
}
