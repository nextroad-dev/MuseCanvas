import { NextResponse, type NextRequest } from 'next/server'
import type { ParameterErrorDetails } from '@musecanvas/contracts'

export const ok = <T>(data: T, init?: ResponseInit) => NextResponse.json({ success: true, data }, init)
/**
 * `details` carries the machine-readable part of a validation failure — which
 * parameter, with what value, broke which rule — so the console can mark the
 * offending control instead of making the user parse a sentence. Additive: every
 * existing caller passes three arguments and every existing client reads only
 * `code` and `message`.
 */
export const fail = (
  code: string,
  message: string,
  status = 400,
  details?: ParameterErrorDetails,
) => NextResponse.json(
  { success: false, error: details ? { code, message, details } : { code, message } },
  { status },
)
export async function body(request: NextRequest): Promise<Record<string, unknown>> { try { return await request.json() } catch { return {} } }
export const emailValid = (value: unknown): value is string => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
export function clientIpFromRequest(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    const entries = forwarded.split(',').map(v => v.trim()).filter(Boolean)
    // nginx 以 $proxy_add_x_forwarded_for 追加真实 IP，最右段由可信反代写入；最左段是客户端可伪造值
    if (entries.length) return entries[entries.length - 1]
  }
  return request.headers.get('x-real-ip')?.trim() || 'unknown'
}

export function mutationOriginValid(request: NextRequest): boolean {
  const origin = request.headers.get('origin'); if (!origin) return true
  let originHost: string
  try { originHost = new URL(origin).host.toLowerCase() } catch { return false }
  const candidates: string[] = []
  // nginx 以 proxy_set_header X-Forwarded-Host $http_host 覆写客户端注入值；
  // 若代理改为追加模式，伪造值只会落在最左段，取最右段同样安全
  const forwardedHost = request.headers.get('x-forwarded-host')
  if (forwardedHost) {
    const entries = forwardedHost.split(',').map(v => v.trim().toLowerCase()).filter(Boolean)
    if (entries.length) candidates.push(entries[entries.length - 1])
  }
  const host = request.headers.get('host')
  if (host) candidates.push(host.trim().toLowerCase())
  return candidates.includes(originHost)
}
