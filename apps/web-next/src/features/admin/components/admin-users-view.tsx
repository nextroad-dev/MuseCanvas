'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type { AdminUser, Invitation } from '@/shared/types'
import { Loader2, Plus, RefreshCw, Trash2, UserPlus, X } from 'lucide-react'

export function AdminUsersView() {
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<'users' | 'invitations'>('users')

  const [actionError, setActionError] = useState<string>('')

  // Create invitation modal state
  const [inviteModalOpen, setInviteModalOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')

  const {
    data: users = [],
    isLoading: usersLoading,
    refetch: refetchUsers,
  } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: async () => {
      const res = await api<{ items: AdminUser[] }>(API_ENDPOINTS.admin.users)
      return res.data?.items || []
    },
  })

  const {
    data: invitations = [],
    isLoading: invitesLoading,
    refetch: refetchInvites,
  } = useQuery({
    queryKey: ['admin', 'invitations'],
    queryFn: async () => {
      const res = await api<{ items: Invitation[] }>(API_ENDPOINTS.admin.invitations)
      // Rows carry the admin-decryptable plaintext code (undefined for pre-encryption legacy rows).
      return res.data?.items || []
    },
  })

  // Create invitation mutation
  const createInviteMutation = useMutation({
    mutationFn: async () => {
      const res = await api<Invitation>(API_ENDPOINTS.admin.invitations, {
        method: 'POST',
        body: { email: inviteEmail.trim() || undefined },
      })
      if (!res.success) {
        throw new Error(res.error?.message || '创建邀请码失败')
      }
      return res.data
    },
    onSuccess: () => {
      setInviteModalOpen(false)
      setInviteEmail('')
      queryClient.invalidateQueries({ queryKey: ['admin', 'invitations'] })
    },
    onError: (err: any) => {
      setActionError(err.message || '创建邀请码失败')
    },
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">用户与邀请管理</h1>
          <p className="text-sm text-muted-foreground">管理注册用户、角色权限与测试邀请码。</p>
        </div>
        <div className="flex gap-2">
          {activeTab === 'invitations' && (
            <button
              type="button"
              onClick={() => {
                setActionError('')
                setInviteModalOpen(true)
              }}
              className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-3 text-xs font-medium text-accent-contrast transition-colors hover:bg-accent-hover"
            >
              <UserPlus className="h-3.5 w-3.5" />
              创建邀请码
            </button>
          )}
          <button
            type="button"
            onClick={() => (activeTab === 'users' ? refetchUsers() : refetchInvites())}
            className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border">
        <button
          type="button"
          onClick={() => setActiveTab('users')}
          className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'users'
              ? 'border-accent text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          注册用户 ({users.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('invitations')}
          className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'invitations'
              ? 'border-accent text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          邀请码 ({invitations.length})
        </button>
      </div>

      {/* Users Tab */}
      {activeTab === 'users' && (
        <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-border bg-surface-subtle text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">邮箱</th>
                <th className="px-4 py-3 font-medium">角色</th>
                <th className="px-4 py-3 font-medium">注册时间</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {usersLoading ? (
                <tr>
                  <td colSpan={3} className="p-8 text-center text-muted-foreground">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                  </td>
                </tr>
              ) : users.length > 0 ? (
                users.map((u) => (
                  <tr key={u.id} className="hover:bg-surface-subtle/50 transition-colors">
                    <td className="px-4 py-3 font-medium text-foreground">{u.email}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium ${
                          u.role === 'admin'
                            ? 'bg-accent-soft text-accent'
                            : 'bg-surface-subtle text-muted-foreground'
                        }`}
                      >
                        {u.role}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-muted-foreground">
                      {new Date(u.createdAt).toLocaleDateString('zh-CN')}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3} className="p-8 text-center text-muted-foreground">
                    暂无用户
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Invitations Tab */}
      {activeTab === 'invitations' && (
        <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-border bg-surface-subtle text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">邀请码标识</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">创建时间</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {invitesLoading ? (
                <tr>
                  <td colSpan={3} className="p-8 text-center text-muted-foreground">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                  </td>
                </tr>
              ) : invitations.length > 0 ? (
                invitations.map((inv) => (
                  <tr key={inv.id} className="hover:bg-surface-subtle/50 transition-colors">
                    <td className="px-4 py-3 font-mono font-bold text-foreground">{inv.code || inv.id}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium ${
                          inv.used
                            ? 'bg-danger-soft text-danger'
                            : inv.revoked
                              ? 'bg-surface-subtle text-muted-foreground'
                              : 'bg-success-soft text-success'
                        }`}
                      >
                        {inv.used ? '已使用' : inv.revoked ? '已撤销' : '有效'}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-muted-foreground">
                      {new Date(inv.createdAt).toLocaleDateString('zh-CN')}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3} className="p-8 text-center text-muted-foreground">
                    暂无邀请码
                  </td>
                </tr>
              )}

            </tbody>
          </table>
        </div>
      )}

      {/* Create Invite Modal */}
      {inviteModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/40" onClick={() => setInviteModalOpen(false)} />
          <div className="relative z-10 w-full max-w-sm rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-foreground">创建新邀请码</h3>
              <button
                type="button"
                onClick={() => setInviteModalOpen(false)}
                className="rounded p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {actionError && (
              <div className="rounded border border-danger-soft bg-danger-soft/20 p-2 text-xs text-danger">
                {actionError}
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-foreground mb-1">
                限定邮箱（可选，留空则任意人可用）
              </label>
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="user@example.com"
                className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setInviteModalOpen(false)}
                className="rounded-[var(--radius-control)] border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-surface-subtle"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => createInviteMutation.mutate()}
                disabled={createInviteMutation.isPending}
                className="flex items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-4 py-1.5 text-xs font-medium text-accent-contrast hover:bg-accent-hover disabled:opacity-50"
              >
                {createInviteMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                生成邀请码
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
