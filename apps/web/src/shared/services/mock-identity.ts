// 本地演示身份常量：服务端 RSC（admin/account/setup）与浏览器 mock 共用。
// 不包含 'use client'，避免被当作客户端引用而无法在 RSC 读取字段。

import type { AccountDto, OAuthIdentityDto, SessionUserDto } from '@/shared/types'

export const MOCK_SESSION_USER: SessionUserDto = {
  id: '00000000-0000-4000-8000-00000000a001',
  email: 'admin@example.invalid',
  role: 'admin',
  status: 'active',
  createdAt: '2026-10-01T08:00:00.000Z',
}

export const MOCK_SETUP_COMPLETED_AT = '2026-10-01T08:30:00.000Z'

export const MOCK_OAUTH_IDENTITIES: OAuthIdentityDto[] = [
  {
    id: '00000000-0000-4000-8000-00000000b001',
    provider: 'github',
    email: 'jude@example.invalid',
    displayName: 'Demo Maker',
    linkedAt: '2026-10-02T09:00:00.000Z',
    lastLoginAt: '2026-11-20T09:00:00.000Z',
  },
]

export const MOCK_ACCOUNT: AccountDto = {
  user: MOCK_SESSION_USER,
  oauthIdentities: MOCK_OAUTH_IDENTITIES,
}
