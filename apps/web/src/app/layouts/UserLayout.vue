<script setup lang="ts">
import { ref, computed } from 'vue'
import { RouterView, RouterLink, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/features/auth/stores/auth'
import { Menu, LogOut, Settings } from 'lucide-vue-next'
import { cn } from '@/shared/lib/utils'
import { useClickOutside } from '@/shared/composables/useClickOutside'
import AppDrawer from '@/shared/components/ui/AppDrawer.vue'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
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

function handleLogout() {
  closeUserMenu()
  auth.logout()
}

useClickOutside(userMenuRef, closeUserMenu)
</script>

<template>
  <div class="flex h-screen flex-col bg-canvas text-foreground">
    <!-- Top bar -->
    <header class="flex h-16 shrink-0 items-center border-b border-border bg-surface px-4 sm:px-6">
      <RouterLink to="/generate" class="flex items-center gap-2">
        <img src="/brand/musecanvas_flow_ribbon_final_pack/03_transparent_trimmed_png/03_wordmark_transparent_trimmed.png" alt="MuseCanvas" class="h-5 w-auto" />
      </RouterLink>

      <!-- Desktop nav -->
      <nav class="ml-6 hidden items-center gap-1 md:flex">
        <RouterLink
          v-for="item in navItems"
          :key="item.name"
          :to="item.path"
          :aria-current="route.name === item.name ? 'page' : undefined"
          :class="cn(
            'rounded-[var(--radius-control)] px-3 py-1.5 text-sm font-medium transition-colors',
            route.name === item.name
              ? 'bg-primary-soft text-primary'
              : 'text-muted-foreground hover:bg-surface-subtle hover:text-foreground',
          )"
        >
          {{ item.label }}
        </RouterLink>
      </nav>

      <!-- Mobile: page name + menu -->
      <span class="ml-3 text-sm font-medium text-foreground md:hidden">{{ currentPageName }}</span>

      <div class="ml-auto flex items-center gap-3">
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
            class="flex h-8 w-8 items-center justify-center rounded-full bg-primary-soft text-sm font-medium text-primary"
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
      <RouterLink
        v-for="item in navItems"
        :key="item.name"
        :to="item.path"
        :class="cn(
          'rounded-[var(--radius-control)] px-3 py-2.5 text-sm font-medium transition-colors',
          route.name === item.name
            ? 'bg-primary-soft text-primary'
            : 'text-muted-foreground hover:bg-surface-subtle',
        )"
        @click="drawerOpen = false"
      >
        {{ item.label }}
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
