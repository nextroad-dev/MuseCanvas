'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { api } from '@/shared/services/api'
import { useAuthUiStore } from '@/shared/stores/auth-ui-store'
import type { User } from '@/shared/types'
import { ArrowLeft, Loader2, Mail, ShieldCheck, Sparkles } from 'lucide-react'

type Step = 'email' | 'invitation' | 'otp'

export function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const from = searchParams.get('from') || '/generate'

  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [otpCode, setOtpCode] = useState('')
  const [invitationCode, setInvitationCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const setUser = useAuthUiStore((s) => s.setUser)

  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) {
      setError('请输入邮箱地址')
      return
    }
    setError('')
    setLoading(true)

    try {
      const res = await api<{ accepted: boolean; nextStep: 'invitation' | 'otp' }>(
        '/api/auth/otp/request',
        {
          method: 'POST',
          body: { email: email.trim(), invitationCode: invitationCode.trim() || undefined },
        },
      )
      setLoading(false)

      if (res.success && res.data) {
        setStep(res.data.nextStep)
      } else {
        setError(res.error?.message || '发送验证码失败，请重试')
      }
    } catch {
      setLoading(false)
      setError('网络连接错误，请稍后重试')
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault()
    if (!otpCode.trim()) {
      setError('请输入验证码')
      return
    }
    setError('')
    setLoading(true)

    try {
      const res = await api<{ user: User }>('/api/auth/otp/verify', {
        method: 'POST',
        body: {
          email: email.trim(),
          code: otpCode.trim(),
          invitationCode: invitationCode.trim() || undefined,
        },
      })
      setLoading(false)

      if (res.success && res.data?.user) {
        setUser(res.data.user)
        router.push(from)
        router.refresh()
      } else {
        setError(res.error?.message || '验证码错误或已过期')
      }
    } catch {
      setLoading(false)
      setError('网络连接错误，请稍后重试')
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1 text-center">
        <h1 className="text-title font-semibold tracking-tight text-foreground">
          {step === 'otp' ? '输入验证码' : step === 'invitation' ? '需要邀请码' : '登录 MuseCanvas'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {step === 'otp'
            ? `验证码已发送至 ${email}`
            : step === 'invitation'
              ? '当前平台处于邀请测试期，请输入有效邀请码'
              : '无需复杂密码，通过邮箱验证码极速登录'}
        </p>
      </div>

      {error && (
        <div className="rounded-[var(--radius-control)] border border-danger-soft bg-danger-soft/30 p-3 text-xs text-danger">
          {error}
        </div>
      )}

      {step === 'email' && (
        <form onSubmit={handleSendOtp} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="email" className="block text-xs font-medium text-foreground">
              邮箱地址
            </label>
            <div className="relative">
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-accent focus:ring-1 focus:ring-accent"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="flex w-full min-h-10 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-accent px-4 text-sm font-medium text-accent-contrast transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <Mail className="h-4 w-4" />
                获取登录验证码
              </>
            )}
          </button>
        </form>
      )}

      {step === 'invitation' && (
        <form onSubmit={handleSendOtp} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="invite" className="block text-xs font-medium text-foreground">
              邀请码
            </label>
            <input
              id="invite"
              type="text"
              required
              value={invitationCode}
              onChange={(e) => setInvitationCode(e.target.value)}
              placeholder="请输入邀请码"
              className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setStep('email')}
              className="flex min-h-10 items-center justify-center rounded-[var(--radius-control)] border border-border bg-surface px-3 text-sm text-muted-foreground hover:bg-surface-subtle"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex flex-1 min-h-10 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-accent px-4 text-sm font-medium text-accent-contrast transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : '确认并发送验证码'}
            </button>
          </div>
        </form>
      )}

      {step === 'otp' && (
        <form onSubmit={handleVerifyOtp} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="otp" className="block text-xs font-medium text-foreground">
              6位验证码
            </label>
            <input
              id="otp"
              type="text"
              required
              maxLength={6}
              autoFocus
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value)}
              placeholder="123456"
              className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-2 text-center text-xl font-mono tracking-widest text-foreground outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setStep('email')}
              className="flex min-h-10 items-center justify-center rounded-[var(--radius-control)] border border-border bg-surface px-3 text-sm text-muted-foreground hover:bg-surface-subtle"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex flex-1 min-h-10 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-accent px-4 text-sm font-medium text-accent-contrast transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : '验证并登录'}
            </button>
          </div>
        </form>
      )}

      <div className="relative border-t border-border pt-4">
        <p className="text-center text-xs text-muted-foreground">或者通过第三方授权直接登录</p>
        <div className="mt-3 flex justify-center gap-3">
          <a
            href="/api/auth/oauth/github/start"
            className="flex min-h-10 items-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface px-4 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle"
          >
            GitHub 登录
          </a>
          <a
            href="/api/auth/oauth/google/start"
            className="flex min-h-10 items-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface px-4 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle"
          >
            Google 登录
          </a>
        </div>
      </div>
    </div>
  )
}
