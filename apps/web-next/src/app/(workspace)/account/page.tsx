import { AccountView } from '@/features/account/components/account-view'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '账户设置 - MuseCanvas',
  description: 'MuseCanvas 账户配置与安全设置',
}

export default function AccountPage() {
  return <AccountView />
}
