'use client'

import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/shared/services/api'
import type { BillingSettings, UpdateBillingSettingsInput } from '@/shared/types'
import { Coins, Loader2, RefreshCw, Save, AlertCircle } from 'lucide-react'

export function AdminBillingView() {
  const queryClient = useQueryClient()
  const [enabled, setEnabled] = useState(true)
  const [signupGrant, setSignupGrant] = useState(100)
  const [promptOptimizationCredits, setPromptOptimizationCredits] = useState(1)
  const [statusMsg, setStatusMsg] = useState('')

  const {
    data: billing,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['admin', 'billing-settings'],
    queryFn: async () => {
      const res = await api<BillingSettings>('/api/admin/billing-settings')
      return res.data || null
    },
  })

  useEffect(() => {
    if (billing) {
      setEnabled(billing.enabled)
      setSignupGrant(billing.signupGrant)
      setPromptOptimizationCredits(billing.promptOptimizationCredits)
    }
  }, [billing])

  const saveMutation = useMutation({
    mutationFn: async () => {
      setStatusMsg('')
      const payload: UpdateBillingSettingsInput = {
        enabled,
        signupGrant: Number(signupGrant || 0),
        promptOptimizationCredits: Number(promptOptimizationCredits || 0),
      }
      const res = await api<BillingSettings>('/api/admin/billing-settings', {
        method: 'PATCH',
        body: payload,
      })
      if (!res.success) throw new Error(res.error?.message || '保存设置失败')
      return res.data
    },
    onSuccess: () => {
      setStatusMsg('计费设置已更新')
      queryClient.invalidateQueries({ queryKey: ['admin', 'billing-settings'] })
    },
    onError: (err: any) => {
      setStatusMsg(err.message || '保存失败')
    },
  })

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">计费设置</h1>
          <p className="text-sm text-muted-foreground">管理全局计费开关、新用户注册赠送积分以及提示词优化积分消耗。</p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          刷新
        </button>
      </div>

      {statusMsg && (
        <div className="rounded-[var(--radius-control)] border border-border bg-surface-subtle p-3 text-xs text-foreground">
          {statusMsg}
        </div>
      )}

      <div className="rounded-[var(--radius-card)] border border-border bg-surface p-6 space-y-6">
        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground">
            <Loader2 className="mx-auto h-5 w-5 animate-spin" />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 pb-4 border-b border-border">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Coins className="h-4 w-4 text-accent" />
                  全局积分计费系统
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  关闭后，用户可无视积分余额自由发起生图；开启后系统将按模型单价冻结并扣减积分。
                </p>
              </div>
              <label className="relative inline-flex cursor-pointer items-center">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  className="peer sr-only"
                />
                <div className="h-6 w-11 rounded-full bg-border peer-checked:bg-accent after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:after:translate-x-full" />
              </label>
            </div>

            <div>
              <label className="block text-xs font-medium text-foreground mb-1">
                新用户注册默认赠送积分
              </label>
              <input
                type="number"
                min="0"
                value={signupGrant}
                onChange={(e) => setSignupGrant(parseInt(e.target.value, 10) || 0)}
                className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-2 text-sm text-foreground outline-none"
              />
              <p className="mt-1 text-xs text-muted-foreground">新用户完成注册时自动发放的初始可用积分数量。</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-foreground mb-1">
                提示词优化额外消耗积分
              </label>
              <input
                type="number"
                min="0"
                value={promptOptimizationCredits}
                onChange={(e) => setPromptOptimizationCredits(parseInt(e.target.value, 10) || 0)}
                className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-2 text-sm text-foreground outline-none"
              />
              <p className="mt-1 text-xs text-muted-foreground">任务启用提示词优化时，每单任务固定追加的积分报价。</p>
            </div>

            <div className="pt-4 border-t border-border flex justify-end">
              <button
                type="button"
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
                className="flex items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-4 py-2 text-sm font-medium text-accent-contrast hover:bg-accent-hover disabled:opacity-50"
              >
                {saveMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                保存设置
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

