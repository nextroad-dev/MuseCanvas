'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createLoginRequestGate } from '../lib/login-request-state'
import type { FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import { ArrowLeftIcon as ArrowLeft, EnvelopeSimpleIcon as Mail } from '@phosphor-icons/react'
import { api, ApiError } from '@/shared/services/api'
import { ACCOUNT_QUERY_KEY } from '@/shared/hooks/useAccount'
import type { User, OAuthProviderInfo } from '@/shared/types'
import { safeRedirectPath } from '@/shared/lib/app-routes'
import {
  Alert,
  Button,
  Divider,
  FieldGroup,
  FormField,
  IconButton,
  Input,
  buttonVariants,
  iconSize,
} from '@/shared/components/ui'
import { GithubIcon, GoogleIcon } from '@/shared/components/brand-icons'

type Step = 'email' | 'invitation' | 'otp'
/** Every step owns exactly one field, so a failed request has a home to report in. */
type FieldKey = 'email' | 'invitation' | 'otp'
type FieldErrors = Partial<Record<FieldKey, string>>

const fieldOfStep: Record<Step, FieldKey> = {
  email: 'email',
  invitation: 'invitation',
  otp: 'otp',
}

/** Shape check only — the backend stays the authority on whether an address exists. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** copy.md §4: 发生了什么 + 为什么 + 如何解决. */
const NETWORK_ERROR = '网络连接失败。设备可能未联网或后端服务暂时不可用，请检查网络后重试。'
const OTP_SEND_FAILED = '验证码发送失败。请确认邮箱地址填写无误，稍后重新发送。'

export function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const from = safeRedirectPath(searchParams.get('from'))
  const oauthError = searchParams.get('error')

  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [otpCode, setOtpCode] = useState('')
  const [invitationCode, setInvitationCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [requestGate] = useState(createLoginRequestGate)
  useEffect(() => () => requestGate.cancel(), [requestGate])
  const providers = useQuery({
    queryKey: ['auth', 'oauth-providers'],
    queryFn: async ({ signal }) => {
      const res = await api<OAuthProviderInfo[]>(API_ENDPOINTS.auth.oauthProviders, { signal })
      if (!res.success || !Array.isArray(res.data)) throw new ApiError('PROVIDERS_UNAVAILABLE', '暂时无法读取第三方登录方式。请重试或使用邮箱验证码。')
      return res.data
    },
    retry: false,
    staleTime: 60_000,
  })

  function invalidateRequest() {
    requestGate.cancel()
    setLoading(false)
  }

  // Focus lands on the first invalid field after a submit (components.md → Inline
  // error), never while the user is still typing.
  const inputRefs = useRef<Partial<Record<FieldKey, HTMLInputElement | null>>>({})
  const focusFirstError = useCallback((next: FieldErrors) => {
    const first = (Object.keys(fieldOfStep) as FieldKey[]).find((key) => Boolean(next[key]))
    if (first) inputRefs.current[first]?.focus()
  }, [])

  const queryClient = useQueryClient()
  useEffect(() => { inputRefs.current[fieldOfStep[step]]?.focus() }, [step])

  /** Typing clears only the field's own error, so a hint never fights another. */
  function clearFieldError(key: FieldKey) {
    setErrors((previous) => {
      if (!previous[key]) return previous
      const next: FieldErrors = { ...previous }
      delete next[key]
      return next
    })
  }

  function reportFailure(message: string) {
    const next: FieldErrors = {}
    next[fieldOfStep[step]] = message
    setErrors(next)
    focusFirstError(next)
  }

  async function handleSendOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const trimmedEmail = email.trim()
    const next: FieldErrors = {}
    if (!trimmedEmail) {
      next.email = '邮箱地址不能为空。请填写用于接收登录验证码的邮箱地址。'
    } else if (!EMAIL_PATTERN.test(trimmedEmail)) {
      next.email = '邮箱地址格式不正确。请确认包含 @ 和完整域名，例如 name@example.com。'
    }
    if (step === 'invitation' && !invitationCode.trim()) {
      next.invitation = '邀请码不能为空。请填写收到的邀请码，每个邀请码通常只能使用一次。'
    }

    setErrors(next)
    if (next.email || next.invitation) {
      focusFirstError(next)
      return
    }

    const request = requestGate.begin()
    if (!request) return
    setLoading(true)

    try {
      const res = await api<{ accepted: boolean; nextStep: 'invitation' | 'otp' }>(
        API_ENDPOINTS.auth.otpRequest,
        {
          method: 'POST',
          body: { email: trimmedEmail, invitationCode: invitationCode.trim() || undefined },
          signal: request.signal,
        },
      )
      if (!requestGate.current(request.id)) return
      requestGate.finish(request.id)
      setLoading(false)

      if (res.success && res.data) {
        setStep(res.data.nextStep)
        return
      }
      reportFailure(res.error?.message || OTP_SEND_FAILED)
    } catch {
      if (!requestGate.current(request.id)) return
      requestGate.finish(request.id)
      setLoading(false)
      reportFailure(NETWORK_ERROR)
    }
  }

  async function handleVerifyOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!otpCode.trim()) {
      const next: FieldErrors = { otp: '验证码不能为空。请输入邮件中收到的 6 位验证码。' }
      setErrors(next)
      focusFirstError(next)
      return
    }

    const request = requestGate.begin()
    if (!request) return
    setLoading(true)

    try {
      const res = await api<{ user: User }>(API_ENDPOINTS.auth.otpVerify, {
        method: 'POST',
        body: {
          email: email.trim(),
          code: otpCode.trim(),
          invitationCode: invitationCode.trim() || undefined,
        },
        signal: request.signal,
      })
      if (!requestGate.current(request.id)) return
      requestGate.finish(request.id)
      setLoading(false)

      if (res.success && res.data?.user) {
        // Seed the session query so the signed-in user is the single source of
        // truth the moment we navigate away from the login screen.
        queryClient.setQueryData(ACCOUNT_QUERY_KEY, res.data.user)
        router.push(from)
        router.refresh()
        return
      }
      reportFailure(
        res.error?.message || '验证码错误或已过期。请输入邮件中最新的一条验证码，或返回上一步重新发送。',
      )
    } catch {
      if (!requestGate.current(request.id)) return
      requestGate.finish(request.id)
      setLoading(false)
      reportFailure(NETWORK_ERROR)
    }
  }

  /** Returns to the email step; the typed values stay in state (失败保留输入). */
  function backToEmail() {
    invalidateRequest()
    setErrors({})
    setStep('email')
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-title text-foreground">
          {step === 'otp' ? '输入验证码' : step === 'invitation' ? '需要邀请码' : '登录\u00A0MuseCanvas'}
        </h1>
        <p
          className={`min-w-0 text-sm text-muted-foreground [text-wrap:pretty] ${
            step === 'otp' ? '[overflow-wrap:anywhere]' : ''
          }`}
        >
          {step === 'otp'
            ? `验证码已发送至 ${email}，请在下方输入邮件里的 6 位验证码。`
            : step === 'invitation'
              ? '当前平台处于邀请测试期，请填写有效邀请码。'
              : '无需复杂密码，通过邮箱验证码登录。'}
        </p>
      </header>

      {oauthError && <Alert tone="warning" title="第三方登录未完成">授权可能已取消或暂不可用。请重试已启用的登录方式，或使用邮箱验证码；回调不会自动提交新请求。</Alert>}

      {step === 'email' && (
        <form noValidate onSubmit={handleSendOtp} className="flex flex-col gap-6">
          <FieldGroup>
            <FormField
              id="email"
              label="邮箱地址"
              required
              hint="邮箱只用于登录与作品找回。"
              error={errors.email}
            >
              <Input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => {
                  invalidateRequest()
                  setEmail(event.target.value)
                  clearFieldError('email')
                }}
                placeholder="name@example.com"
                ref={(node) => {
                  inputRefs.current.email = node
                }}
              />
            </FormField>
          </FieldGroup>

          <Button
            type="submit"
            size="lg"
            loading={loading}
            fullWidth
            icon={<Mail weight="bold" aria-hidden="true" />}
          >
            获取登录验证码
          </Button>
        </form>
      )}

      {step === 'invitation' && (
        <form noValidate onSubmit={handleSendOtp} className="flex flex-col gap-6">
          <FieldGroup>
            <FormField
              id="invite"
              label="邀请码"
              required
              hint="邀请码由发放方提供，可能只能使用一次。"
              error={errors.invitation}
            >
              <Input
                type="text"
                autoComplete="off"
                value={invitationCode}
                onChange={(event) => {
                  invalidateRequest()
                  setInvitationCode(event.target.value)
                  clearFieldError('invitation')
                }}
                placeholder="请填写邀请码"
                ref={(node) => {
                  inputRefs.current.invitation = node
                }}
              />
            </FormField>
          </FieldGroup>

          <div className="flex items-center gap-3">
            <IconButton
              variant="secondary"
              size="lg"
              aria-label="返回上一步，检查邮箱地址"
              onClick={backToEmail}
              icon={<ArrowLeft weight="bold" aria-hidden="true" />}
            />
            <Button type="submit" size="lg" loading={loading} className="flex-1">
              确认并发送验证码
            </Button>
          </div>
        </form>
      )}

      {step === 'otp' && (
        <form noValidate onSubmit={handleVerifyOtp} className="flex flex-col gap-6">
          <FieldGroup>
            <FormField
              id="otp"
              label={`6\u00A0位验证码`}
              required
              hint={`发送至 ${email}`}
              error={errors.otp}
            >
              <Input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                value={otpCode}
                onChange={(event) => {
                  invalidateRequest()
                  setOtpCode(event.target.value)
                  clearFieldError('otp')
                }}
                placeholder="123456"
                className="text-center font-mono tracking-widest"
                ref={(node) => {
                  inputRefs.current.otp = node
                }}
              />
            </FormField>
          </FieldGroup>

          <div className="flex items-center gap-3">
            <IconButton
              variant="secondary"
              size="lg"
              aria-label="返回上一步，重新填写邮箱地址"
              onClick={backToEmail}
              icon={<ArrowLeft weight="bold" aria-hidden="true" />}
            />
            <Button type="submit" size="lg" loading={loading} className="flex-1">
              验证并登录
            </Button>
          </div>
        </form>
      )}

      <section className="flex flex-col gap-4" aria-label="第三方账号登录">
        <Divider label="或使用第三方账号登录" />
        {providers.isPending ? <p role="status" className="text-center text-xs text-muted-foreground">正在读取可用登录方式…</p> : null}
        {providers.error && <Alert tone="warning" action={<Button variant="secondary" size="sm" loading={providers.isFetching} onClick={() => void providers.refetch()}>重试</Button>}>暂时无法读取第三方登录方式，请重试或使用邮箱验证码。</Alert>}
        {providers.data && !providers.data.some(provider => provider.enabled) && <p className="text-center text-xs text-muted-foreground">当前没有启用第三方登录，请使用邮箱验证码。</p>}
        {providers.data?.some(provider => provider.enabled) && (
          <div className="flex flex-col gap-3 sm:flex-row">
            {providers.data.filter(provider => provider.enabled).map(provider => (
              <a key={provider.provider}
                href={API_ENDPOINTS.auth.oauthStart(provider.provider)}
                className={buttonVariants({ variant: 'secondary', size: 'lg', className: 'min-w-0 flex-1 gap-2' })}
              >
                {provider.provider === 'github' ? <GithubIcon className={`${iconSize.md} shrink-0`} /> : <GoogleIcon className={`${iconSize.md} shrink-0`} />}
                <span>使用 {provider.label} 登录</span>
              </a>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
