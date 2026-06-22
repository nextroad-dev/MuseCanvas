import { NextResponse, type NextRequest } from 'next/server'

export const ok = <T>(data: T, init?: ResponseInit) => NextResponse.json({ success: true, data }, init)
export const fail = (code: string, message: string, status = 400) => NextResponse.json({ success: false, error: { code, message } }, { status })
export async function body(request: NextRequest): Promise<Record<string, unknown>> { try { return await request.json() } catch { return {} } }
export const emailValid = (value: unknown): value is string => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
export function mutationOriginValid(request: NextRequest): boolean {
  const origin = request.headers.get('origin'); if (!origin) return true
  const forwardedHost = request.headers.get('x-forwarded-host') || request.headers.get('host')
  try { return new URL(origin).host === forwardedHost } catch { return false }
}
