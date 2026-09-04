<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { RouterView, RouterLink, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/features/auth/stores/auth'
import { useAccountStore } from '@/features/account/stores/account'
import { Menu, LogOut, Settings, Coins } from 'lucide-vue-next'
import { useClickOutside } from '@/shared/composables/useClickOutside'
import AppDrawer from '@/shared/components/ui/AppDrawer.vue'
import NavLink from '@/shared/components/ui/NavLink.vue'

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
const userMenuRef = ref<HTMLDivElement | null>(null)

function toggleUserMenu() {
  userMenuOpen.value = !userMenuOpen.value
}

function closeUserMenu() {
  userMenuOpen.value = false
}

function goToAccount() {
  closeUserMenu()
  router.push('/account')
}

async function handleLogout() {
  closeUserMenu()
  await auth.logout()
  router.push('/')
}

useClickOutside(userMenuRef, closeUserMenu)

onMounted(() => {
  if (auth.user) {
    account.fetchCredits()
    account.fetchBillingSettings()
  }
})
</script>

<template>
  <div class="flex h-screen flex-col bg-canvas text-foreground">
    <!-- Top bar -->
    <header class="flex h-16 shrink-0 items-center border-b border-border bg-surface px-4 sm:px-6">
      <RouterLink to="/generate" class="flex items-center gap-2">
        <img src="/brand/musecanvas_flow_ribbon_final_pack/03_transparent_trimmed_png/03_wordmark_transparent_trimmed.png" alt="MuseCanvas" class="h-7 w-auto" />
      </RouterLink>

      <!-- Desktop nav -->
      <nav class="ml-6 hidden items-center gap-1 md:flex">
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
      <span class="ml-3 text-sm font-medium text-foreground md:hidden">{{ currentPageName }}</span>

      <div class="ml-auto flex items-center gap-3">
        <RouterLink
          to="/account"
          class="flex items-center gap-1.5 rounded-[var(--radius-control)] border border-border/80 bg-surface-subtle px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary-soft/30 hover:text-primary"
          title="可用积分"
        >
          <Coins class="h-3.5 w-3.5 text-amber-500" />
          <span>{{ account.creditBalance ? account.creditBalance.availableCredits : '—' }}</span>
          <span class="text-[10px] text-muted-foreground">积分</span>
        </RouterLink>

        <RouterLink
          v-if="auth.isAdmin"
          to="/admin"
          class="hidden h-8 items-center gap-1.5 rounded-[var(--radius-control)] border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-subtle md:inline-flex"
        >
          管理后台
        </RouterLink>

        <!-- User dropdown -->
        <div ref="userMenuRef" class="relative">
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-full bg-primary-soft text-sm font-medium text-primary transition-all hover:ring-2 hover:ring-primary/30 hover:bg-primary/20 active:scale-95"
            :title="auth.user?.email"
            @click.stop="toggleUserMenu"
          >
            {{ userInitial }}
          </button>

          <div
            v-if="userMenuOpen"
            class="absolute right-0 top-full z-50 mt-2 w-40 rounded-[var(--radius-card)] border border-border bg-surface p-1 shadow-md"
          >
            <button
              class="flex w-full items-center gap-2 rounded-[var(--radius-control)] px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface-subtle"
              @click="goToAccount"
            >
              <Settings class="h-4 w-4" />
              安全设置
            </button>
            <button
              class="flex w-full items-center gap-2 rounded-[var(--radius-control)] px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface-subtle"
              @click="handleLogout"
            >
              <LogOut class="h-4 w-4" />
              退出登录
            </button>
          </div>
        </div>

        <!-- Mobile menu button -->
        <button
          class="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground hover:bg-surface-subtle md:hidden"
          aria-label="打开菜单"
          @click="drawerOpen = true"
        >
          <Menu class="h-5 w-5" />
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
    <nav class="flex flex-col gap-1">
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
        class="flex items-center justify-between rounded-[var(--radius-control)] px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-surface-subtle"
        @click="drawerOpen = false"
      >
        <span class="flex items-center gap-2">
          <Coins class="h-4 w-4 text-amber-500" />
          我的积分
        </span>
        <span class="text-xs font-semibold text-foreground">
          {{ account.creditBalance ? `${account.creditBalance.availableCredits} 积分` : '—' }}
        </span>
      </RouterLink>

      <div v-if="auth.isAdmin" class="mt-4 border-t border-border pt-4">
          <RouterLink
          to="/admin"
          class="flex items-center gap-2 rounded-[var(--radius-control)] px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-surface-subtle"
          @click="drawerOpen = false"
        >
          管理后台
        </RouterLink>
      </div>
    </nav>
  </AppDrawer>
</template>
