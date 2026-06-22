<script setup lang="ts">
import { RouterView, RouterLink, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { LogOut, Image, Sparkles, User, ShieldCheck } from 'lucide-vue-next'
import { cn } from '@/lib/utils'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const navItems = [
  { name: 'generate', path: '/generate', label: '生成', icon: Sparkles },
  { name: 'library', path: '/library', label: '图库', icon: Image },
  { name: 'account', path: '/account', label: '账户', icon: User },
]

async function handleLogout() {
  await auth.logout()
  router.push('/login')
}
</script>

<template>
  <div class="flex h-screen flex-col bg-white text-neutral-950">
    <!-- Top bar -->
    <header class="flex h-12 shrink-0 items-center border-b border-neutral-200 px-4">
      <RouterLink to="/generate" class="flex items-center gap-2 text-sm font-semibold">
        <Sparkles class="h-4 w-4 text-primary" />
        <span>MuseCanvas</span>
      </RouterLink>

      <nav class="ml-8 flex items-center gap-1">
        <RouterLink
          v-for="item in navItems"
          :key="item.name"
          :to="item.path"
          :class="
            cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
              route.name === item.name
                ? 'bg-primary-soft text-primary'
                : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-950',
            )
          "
        >
          <component :is="item.icon" class="h-4 w-4" />
          {{ item.label }}
        </RouterLink>
      </nav>

      <div class="ml-auto flex items-center gap-3">
        <RouterLink
          v-if="auth.isAdmin"
          to="/admin"
          class="flex h-8 items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100"
        >
          <ShieldCheck class="h-4 w-4" />
          管理后台
        </RouterLink>
        <span class="text-xs text-neutral-500">{{ auth.user?.email }}</span>
        <button
          class="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-950"
          @click="handleLogout"
        >
          <LogOut class="h-4 w-4" />
        </button>
      </div>
    </header>

    <!-- Main content -->
    <main class="flex min-h-0 flex-1">
      <RouterView />
    </main>
  </div>
</template>
