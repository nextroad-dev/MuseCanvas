<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { ArrowLeft } from 'lucide-vue-next'

defineProps<{
  title: string
  updatedAt: string
}>()
</script>

<template>
  <div class="min-h-screen bg-canvas">
    <!-- Opaque sticky bar: no blur, no transparency. -->
    <nav class="sticky top-0 z-50 border-b border-border bg-surface">
      <div class="mx-auto flex h-16 max-w-[68ch] items-center justify-between px-6">
        <RouterLink to="/" class="flex items-center gap-2 rounded-[var(--radius-control)]" aria-label="返回 MuseCanvas 首页">
          <img src="/brand/musecanvas_flow_ribbon_final_pack/03_transparent_trimmed_png/03_wordmark_transparent_trimmed.png" alt="MuseCanvas" class="h-6 w-auto" />
        </RouterLink>
        <RouterLink to="/login" class="inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft class="h-4 w-4" aria-hidden="true" />
          返回登录
        </RouterLink>
      </div>
    </nav>

    <!-- Reading measure stays between 60 and 72 characters. -->
    <main class="mx-auto max-w-[68ch] px-6 py-12">
      <h1 class="text-title font-normal leading-[1.25] text-foreground">{{ title }}</h1>
      <p class="mt-2 text-sm text-muted-foreground">最后更新：{{ updatedAt }}</p>

      <div
        class="mt-10 space-y-10 [&_h2]:text-subtitle [&_h2]:font-normal [&_h2]:leading-[1.4] [&_h2]:text-foreground [&_p]:mt-3 [&_p]:text-base [&_p]:leading-[1.59] [&_p]:text-muted-foreground [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5 [&_ul]:text-base [&_ul]:leading-[1.59] [&_ul]:text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground"
      >
        <slot />
      </div>
    </main>
  </div>
</template>