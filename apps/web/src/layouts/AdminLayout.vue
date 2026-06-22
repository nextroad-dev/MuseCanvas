<script setup lang="ts">
import { RouterView, RouterLink, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import {
  LayoutDashboard,
  UserPlus,
  Mail,
  ShieldCheck,
  Users,
  Cpu,
  ListTodo,
  Key,
  ArrowLeft,
  LogOut,
} from 'lucide-vue-next'
import { cn } from '@/lib/utils'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const navItems = [
  { name: 'admin-dashboard', path: '/admin', label: '仪表盘', icon: LayoutDashboard },
  { name: 'admin-registration', path: '/admin/registration', label: '注册管理', icon: UserPlus },
  { name: 'admin-smtp', path: '/admin/smtp', label: 'SMTP', icon: Mail },
  { name: 'admin-oauth', path: '/admin/oauth', label: 'OAuth', icon: ShieldCheck },
  { name: 'admin-users', path: '/admin/users', label: '用户管理', icon: Users },
  { name: 'admin-models', path: '/admin/models', label: '模型管理', icon: Cpu },
  { name: 'admin-providers', path: '/admin/providers', label: '供应商凭据', icon: Key },
  { name: 'admin-jobs', path: '/admin/jobs', label: '任务管理', icon: ListTodo },
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
      <RouterLink
        to="/generate"
        class="flex items-center gap-1.5 text-sm text-neutral-500 hover:text-neutral-950"
      >
        <ArrowLeft class="h-4 w-4" />
        返回用户端
      </RouterLink>

      <span class="ml-4 text-sm font-semibold">管理后台</span>

      <div class="ml-auto flex items-center gap-3">
        <span class="text-xs text-neutral-500">{{ auth.user?.email }}</span>
        <button
          class="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-950"
          @click="handleLogout"
        >
          <LogOut class="h-4 w-4" />
        </button>
      </div>
    </header>

    <div class="flex min-h-0 flex-1">
      <!-- Sidebar -->
      <aside class="w-48 shrink-0 border-r border-neutral-200 py-3">
        <nav class="flex flex-col gap-0.5 px-2">
          <RouterLink
            v-for="item in navItems"
            :key="item.name"
            :to="item.path"
            :class="
              cn(
                'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                route.name === item.name
                  ? 'border-l-2 border-primary bg-primary-soft pl-2.5 text-primary'
                  : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-950',
              )
            "
          >
            <component :is="item.icon" class="h-4 w-4" />
            {{ item.label }}
          </RouterLink>
        </nav>
      </aside>

      <!-- Content -->
      <main class="flex-1 overflow-auto p-6">
        <RouterView />
      </main>
    </div>
  </div>
</template>
