<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { RouterView, RouterLink, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/features/auth/stores/auth'
import { useAccountStore } from '@/features/account/stores/account'
import { Menu, LogOut, Settings, Coins } from 'lucide-vue-next'
import AppDrawer from '@/shared/components/ui/AppDrawer.vue'
import NavLink from '@/shared/components/ui/NavLink.vue'
import Popover from '@/shared/components/ui/Popover.vue'
import { cn } from '@/shared/lib/utils'

const auth = useAuthStore()
const account = useAccountStore()
const router = useRouter()
const route = useRoute()
const drawerOpen = ref(false)

const navItems = [
  { name: 'generate', path: '/generate', label: '创作' },
  { name: 'library', path: '/library', label: '图库' },
]

const currentPageName = computed(() => {
  const item = navItems.find((n) => n.name === route.name)
  return item?.label || ''
})

const userInitial = computed(() => {
  return auth.user?.email?.charAt(0).toUpperCase() || 'U'
})

const userMenuOpen = ref(false)

function goToAccount() {
  userMenuOpen.value = false
  router.push('/account')
}

async function handleLogout() {
  userMenuOpen.value = false
  await auth.logout()
  router.push('/')
}

const menuItemClass = cn(
  'flex min-h-10 w-full items-center gap-2 rounded-[var(--radius-control)] px-3 text-left text-sm text-foreground transition-colors hover:bg-surface-subtle',
)

onMounted(() => {
  if (auth.user) {
    account.fetchCredits()
    account.fetchBillingSettings()
  }
})
</script>

<template>
  <div class="flex h-screen flex-col bg-canvas text-foreground">
    <!-- Top bar: opaque surface with a bottom border (no glass, no blur). -->
    <header class="flex h-16 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 sm:px-6">
      <RouterLink to="/generate" class="flex items-center gap-2 rounded-[var(--radius-control)]" aria-label="MuseCanvas 创作台">
        <img src="/brand/musecanvas_flow_ribbon_final_pack/03_transparent_trimmed_png/03_wordmark_transparent_trimmed.png" alt="MuseCanvas" class="h-7 w-auto" />
      </RouterLink>

      <!-- Desktop nav -->
      <nav class="hidden items-center gap-1 md:flex" aria-label="主导航">
        <NavLink
          v-for="item in navItems"
          :key="item.name"
          :to="item.path"
          :active="route.name === item.name"
        >
          {{ item.label }}
        </NavLink>
      </nav>

      <!-- Mobile: page name + menu -->
      <span class="text-sm font-medium text-foreground md:hidden">{{ currentPageName }}</span>

      <div class="ml-auto flex items-center gap-2">
        <RouterLink
          to="/account"
          class="flex min-h-10 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface-subtle px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle-strong"
        >
          <Coins class="h-4 w-4 text-credit" aria-hidden="true" />
          <span class="tabular-nums">{{ account.creditBalance ? account.creditBalance.availableCredits : '—' }}</span>
          <span class="text-muted-foreground">积分</span>
        </RouterLink>

        <RouterLink
          v-if="auth.isAdmin"
          to="/admin"
          class="hidden min-h-10 items-center rounded-[var(--radius-control)] px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground md:inline-flex"
        >
          管理后台
        </RouterLink>

        <!-- User menu -->
        <Popover
          v-model="userMenuOpen"
          role="menu"
          label="账户菜单"
          panel-class="right-0 min-w-[200px]"
        >
          <template #trigger="{ open: isOpen, toggle }">
            <button
              type="button"
              class="flex h-10 w-10 items-center justify-center rounded-full bg-surface-subtle text-sm font-medium text-foreground transition-colors hover:bg-surface-subtle-strong"
              :aria-label="`账户菜单：${auth.user?.email || '当前用户'}`"
              aria-haspopup="menu"
              :aria-expanded="isOpen"
              @click.stop="toggle"
            >
              {{ userInitial }}
            </button>
          </template>
          <div role="presentation" class="flex flex-col gap-1">
            <p class="truncate px-3 py-1 text-xs text-muted-foreground">{{ auth.user?.email }}</p>
            <button type="button" role="menuitem" data-menu-item tabindex="-1" :class="menuItemClass" @click="goToAccount">
              <Settings class="h-4 w-4" aria-hidden="true" />
              安全设置
            </button>
            <button type="button" role="menuitem" data-menu-item tabindex="-1" :class="menuItemClass" @click="handleLogout">
              <LogOut class="h-4 w-4" aria-hidden="true" />
              退出登录
            </button>
          </div>
        </Popover>

        <!-- Mobile menu button -->
        <button
          type="button"
          class="inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground md:hidden"
          aria-label="打开导航菜单"
          aria-haspopup="dialog"
          @click="drawerOpen = true"
        >
          <Menu class="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </header>

    <!-- Main content -->
    <main class="flex min-h-0 flex-1 overflow-auto">
      <RouterView />
    </main>
  </div>

  <!-- Mobile drawer -->
  <AppDrawer
    :open="drawerOpen"
    title="导航"
    position="right"
    @update:open="drawerOpen = $event"
  >
    <nav class="flex flex-col gap-1" aria-label="移动导航">
      <NavLink
        v-for="item in navItems"
        :key="item.name"
        :to="item.path"
        :active="route.name === item.name"
        @click="drawerOpen = false"
      >
        {{ item.label }}
      </NavLink>
      <RouterLink
        to="/account"
        class="flex min-h-10 items-center justify-between rounded-[var(--radius-control)] px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground"
        @click="drawerOpen = false"
      >
        <span class="flex items-center gap-2">
          <Coins class="h-4 w-4 text-credit" aria-hidden="true" />
          我的积分
        </span>
        <span class="text-xs font-medium tabular-nums text-foreground">
          {{ account.creditBalance ? `${account.creditBalance.availableCredits} 积分` : '—' }}
        </span>
      </RouterLink>

      <div v-if="auth.isAdmin" class="mt-4 border-t border-border pt-4">
        <RouterLink
          to="/admin"
          class="flex min-h-10 items-center gap-2 rounded-[var(--radius-control)] px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground"
          @click="drawerOpen = false"
        >
          管理后台
        </RouterLink>
      </div>
    </nav>
  </AppDrawer>
</template>