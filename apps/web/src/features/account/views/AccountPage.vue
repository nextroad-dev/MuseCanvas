<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/features/auth/stores/auth'
import { useAccountStore } from '@/features/account/stores/account'
import { Github, Link2, Unlink, ShieldCheck, Calendar, Mail, Coins, RefreshCw } from 'lucide-vue-next'
import ConfirmDialog from '@/shared/components/ui/ConfirmDialog.vue'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import GoogleIcon from '@/shared/components/ui/GoogleIcon.vue'
import Badge from '@/shared/components/ui/Badge.vue'
import { toast } from '@/shared/composables/useToast'

const auth = useAuthStore()
const account = useAccountStore()
const router = useRouter()
const route = useRoute()

const user = computed(() => auth.user)
const unlinkTarget = ref<'github' | 'google' | null>(null)

const PROVIDERS: { provider: 'github' | 'google'; label: string }[] = [
  { provider: 'github', label: 'GitHub' },
  { provider: 'google', label: 'Google' },
]

const OAUTH_ERROR_LABELS: Record<string, string> = {
  OAUTH_EMAIL_MISMATCH: '第三方账户邮箱与当前账户不一致，无法绑定',
  OAUTH_IDENTITY_CONFLICT: '该第三方账户已绑定其他用户',
  OAUTH_PROVIDER_DISABLED: '该第三方登录未启用',
  OAUTH_DENIED: '已取消第三方授权',
  OAUTH_STATE_EXPIRED: '绑定会话已过期，请重试',
}

function isLinked(provider: 'github' | 'google') {
  return account.oauthIdentities.some((i) => i.provider === provider)
}
function providerEnabled(provider: 'github' | 'google') {
  return auth.oauthProviders.some((p) => p.provider === provider && p.enabled)
}

const operationMeta: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'brand' }> = {
  grant: { label: '注册赠送', tone: 'success' },
  adjustment: { label: '系统调账', tone: 'info' },
  reservation: { label: '生成冻结', tone: 'warning' },
  capture: { label: '生成结算', tone: 'brand' },
  release: { label: '冻结释放', tone: 'info' },
}

function getOperationMeta(op: string) {
  return operationMeta[op] || { label: op, tone: 'neutral' as const }
}

async function loadMoreLedger() {
  if (account.ledgerHasMore && !account.ledgerLoading && account.ledgerNextCursor) {
    await account.fetchLedger({ cursor: account.ledgerNextCursor })
  }
}

async function refreshBilling() {
  await Promise.all([
    account.fetchCredits(),
    account.fetchBillingSettings(),
    account.fetchLedger({ reset: true }),
  ])
}

onMounted(async () => {
  await Promise.all([
    account.fetchOAuthIdentities(),
    auth.fetchOAuthProviders(),
    account.fetchCredits(),
    account.fetchBillingSettings(),
    account.fetchLedger({ reset: true }),
  ])
  if (route.query.linked) {
    toast('第三方账户已绑定', 'success')
    router.replace({ query: {} })
  } else if (typeof route.query.error === 'string') {
    toast(OAUTH_ERROR_LABELS[route.query.error] || '绑定失败，请重试', 'error')
    router.replace({ query: {} })
  }
})
async function confirmUnlink() {
  const provider = unlinkTarget.value
  if (!provider) return
  const res = await account.unlinkOAuth(provider)
  unlinkTarget.value = null
  if (res.success) toast('已解除绑定', 'success')
  else toast(res.error?.message || '解除绑定失败', 'error')
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}
const initials = computed(() => {
  const email = user.value?.email || ''
  return email.charAt(0).toUpperCase()
})
</script>

<template>
  <div class="flex h-full w-full justify-center overflow-auto p-6">
    <h1 class="sr-only">账户设置</h1>
    <div class="w-full max-w-2xl space-y-6">
      <!-- Profile Card -->
      <div class="rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-sm">
        <div class="flex items-center gap-4">
          <div class="flex h-14 w-14 items-center justify-center rounded-full bg-primary-soft text-lg font-semibold text-primary">
            {{ initials }}
          </div>
          <div class="min-w-0 flex-1">
            <p class="truncate text-base font-semibold text-foreground">{{ user?.email }}</p>
            <div class="mt-1 flex items-center gap-2">
              <span class="inline-flex items-center rounded-full bg-primary-soft px-2 py-0.5 text-xs font-medium text-primary">
                {{ user?.role === 'admin' ? '管理员' : '用户' }}
              </span>
            </div>
          </div>
        </div>

        <div class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div class="flex items-start gap-3 rounded-[var(--radius-card)] bg-surface-subtle p-4">
            <Mail class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <p class="text-xs text-muted-foreground">邮箱</p>
              <p class="mt-0.5 text-sm font-medium text-foreground">{{ user?.email }}</p>
            </div>
          </div>
          <div class="flex items-start gap-3 rounded-[var(--radius-card)] bg-surface-subtle p-4">
            <Calendar class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <p class="text-xs text-muted-foreground">注册时间</p>
              <p class="mt-0.5 text-sm font-medium text-foreground">
                {{ user?.createdAt ? formatDate(user.createdAt) : '-' }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- Balance Card -->
      <div class="rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-sm">
        <div class="flex items-center justify-between">
          <h3 class="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Coins class="h-4 w-4 text-amber-500" />
            积分余额
          </h3>
          <button
            type="button"
            class="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            @click="refreshBilling"
          >
            <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': account.creditsLoading || account.ledgerLoading }" />
            刷新
          </button>
        </div>

        <div
          v-if="account.creditsError"
          class="mt-3 flex items-center justify-between rounded-[var(--radius-card)] border border-danger/30 bg-danger/10 p-3 text-xs text-danger"
        >
          <span>{{ account.creditsError }}</span>
          <button
            type="button"
            class="font-medium underline hover:no-underline"
            @click="account.fetchCredits"
          >
            重试
          </button>
        </div>

        <div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div class="rounded-[var(--radius-card)] bg-surface-subtle p-4">
            <p class="text-xs text-muted-foreground">可用积分</p>
            <p class="mt-1 text-2xl font-bold text-foreground">
              <span v-if="account.creditsLoading && !account.creditsLoaded" class="text-base font-normal text-muted-foreground">加载中...</span>
              <span v-else-if="account.creditsError && !account.creditsLoaded" class="text-base font-normal text-danger">加载失败</span>
              <span v-else>{{ account.creditBalance ? account.creditBalance.availableCredits : '-' }}</span>
            </p>
          </div>
          <div class="rounded-[var(--radius-card)] bg-surface-subtle p-4">
            <p class="text-xs text-muted-foreground">冻结中积分</p>
            <p class="mt-1 text-2xl font-bold text-muted-foreground">
              <span v-if="account.creditsLoading && !account.creditsLoaded" class="text-base font-normal text-muted-foreground">加载中...</span>
              <span v-else-if="account.creditsError && !account.creditsLoaded" class="text-base font-normal text-danger">加载失败</span>
              <span v-else>{{ account.creditBalance ? account.creditBalance.reservedCredits : '-' }}</span>
            </p>
          </div>
          <div class="rounded-[var(--radius-card)] bg-surface-subtle p-4">
            <p class="text-xs text-muted-foreground">总积分</p>
            <p class="mt-1 text-2xl font-bold text-primary">
              <span v-if="account.creditsLoading && !account.creditsLoaded" class="text-base font-normal text-muted-foreground">加载中...</span>
              <span v-else-if="account.creditsError && !account.creditsLoaded" class="text-base font-normal text-danger">加载失败</span>
              <span v-else>{{ account.creditBalance ? account.creditBalance.totalCredits : '-' }}</span>
            </p>
          </div>
        </div>
        <p v-if="account.creditBalance?.updatedAt" class="mt-3 text-right text-[11px] text-muted-foreground">
          更新时间：{{ formatDateTime(account.creditBalance.updatedAt) }}
        </p>
      </div>

      <!-- Ledger Card -->
      <div class="rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-sm">
        <div class="mb-4 flex items-center justify-between">
          <div>
            <h3 class="text-sm font-semibold text-foreground">积分明细流水</h3>
            <p class="text-xs text-muted-foreground">记录每一笔积分变动记录（共 {{ account.ledgerTotal }} 笔）</p>
          </div>
        </div>

        <div v-if="account.ledgerLoading && !account.ledgerLoaded" class="py-8 text-center text-sm text-muted-foreground">
          正在加载积分流水记录...
        </div>
        <div v-else-if="account.ledgerError && !account.ledgerLoaded" class="py-6 text-center text-xs text-danger">
          <p>{{ account.ledgerError }}</p>
          <button type="button" class="mt-2 text-primary underline" @click="account.fetchLedger({ reset: true })">点击重试</button>
        </div>
        <div v-else-if="account.creditLedger.length === 0" class="py-8 text-center text-sm text-muted-foreground">
          暂无积分变动流水记录
        </div>

        <div v-else class="space-y-3">
          <div
            v-for="entry in account.creditLedger"
            :key="entry.id"
            class="flex flex-col gap-2 rounded-[var(--radius-card)] border border-border/80 bg-surface-subtle p-3 text-xs sm:flex-row sm:items-center sm:justify-between"
          >
            <div class="flex items-center gap-3">
              <Badge :tone="getOperationMeta(entry.operation).tone" class="shrink-0">
                {{ getOperationMeta(entry.operation).label }}
              </Badge>
              <div class="min-w-0">
                <p class="truncate font-medium text-foreground">
                  {{ entry.note || (entry.referenceType ? `${entry.referenceType}:${entry.referenceId}` : '—') }}
                </p>
                <p class="text-[11px] text-muted-foreground">
                  {{ formatDateTime(entry.createdAt) }}
                </p>
              </div>
            </div>

            <div class="flex items-center justify-between gap-4 border-t border-border/50 pt-2 sm:border-0 sm:pt-0">
              <div class="text-right">
                <span
                  class="font-semibold"
                  :class="entry.availableDelta > 0 ? 'text-emerald-500' : entry.availableDelta < 0 ? 'text-rose-500' : 'text-muted-foreground'"
                >
                  {{ entry.availableDelta > 0 ? `+${entry.availableDelta}` : entry.availableDelta }}
                </span>
                <span class="text-muted-foreground"> 可用</span>
              </div>

              <div v-if="entry.reservedDelta !== 0" class="text-right text-muted-foreground">
                <span :class="entry.reservedDelta > 0 ? 'text-amber-500' : 'text-muted-foreground'">
                  {{ entry.reservedDelta > 0 ? `+${entry.reservedDelta}` : entry.reservedDelta }}
                </span>
                <span> 冻结</span>
              </div>

              <div class="text-right text-[11px] text-muted-foreground">
                <span>变动后可用: {{ entry.availableAfter }}</span>
              </div>
            </div>
          </div>

          <div v-if="account.ledgerHasMore" class="pt-3 text-center">
            <BaseButton
              size="sm"
              variant="secondary"
              :loading="account.ledgerLoading"
              @click="loadMoreLedger"
            >
              加载更多记录
            </BaseButton>
          </div>
        </div>
      </div>

      <!-- OAuth Card -->
      <div class="rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-sm">
        <h3 class="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
          <ShieldCheck class="h-4 w-4 text-muted-foreground" />
          第三方账户
        </h3>
        <p class="mb-4 text-xs text-muted-foreground">绑定后可使用第三方账户快速登录；仅可绑定与当前邮箱一致的账户。</p>

        <div class="space-y-3">
          <div
            v-for="p in PROVIDERS"
            :key="p.provider"
            class="flex items-center justify-between rounded-[var(--radius-card)] border border-border px-4 py-3 transition-colors hover:bg-surface-subtle"
          >
            <div class="flex items-center gap-3">
              <div class="flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] bg-surface-subtle">
                <Github v-if="p.provider === 'github'" class="h-5 w-5 text-foreground" />
                <GoogleIcon v-else class="h-5 w-5" />
              </div>
              <div>
                <p class="text-sm font-medium text-foreground">{{ p.label }}</p>
                <p class="text-xs text-muted-foreground">
                  {{ isLinked(p.provider) ? '已绑定' : providerEnabled(p.provider) ? '未绑定' : '未启用' }}
                </p>
              </div>
            </div>

            <BaseButton
              v-if="isLinked(p.provider)"
              size="sm"
              variant="secondary"
              @click="unlinkTarget = p.provider"
            >
              <template #icon>
                <Unlink class="h-3.5 w-3.5" />
              </template>
              解绑
            </BaseButton>
            <BaseButton
              v-else
              size="sm"
              :disabled="!providerEnabled(p.provider)"
              @click="account.linkOAuth(p.provider)"
            >
              <template #icon>
                <Link2 class="h-3.5 w-3.5" />
              </template>
              绑定
            </BaseButton>
          </div>
        </div>
      </div>

    </div>

    <ConfirmDialog
      :open="!!unlinkTarget"
      title="解除第三方绑定"
      :description="`确认解除 ${unlinkTarget === 'github' ? 'GitHub' : 'Google'} 账户的绑定？解除后将无法使用该账户登录。`"
      confirm-text="解绑"
      variant="danger"
      @update:open="(v: boolean) => { if (!v) unlinkTarget = null }"
      @confirm="confirmUnlink"
    />
  </div>
</template>
