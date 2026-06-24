<script setup lang="ts">
import { useRouter } from 'vue-router'
import { ArrowRight, Sparkles, Zap, Palette } from 'lucide-vue-next'

const router = useRouter()

function goToLogin() {
  router.push('/login')
}
</script>

<template>
  <div class="min-h-screen bg-surface-dark text-white antialiased">
    <!-- Navigation -->
    <nav class="fixed top-0 left-0 right-0 z-50 border-b border-white/5 backdrop-blur-md">
      <div class="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <div class="flex items-center gap-2">
          <img src="/brand/musecanvas_flow_ribbon_final_pack/03_transparent_trimmed_png/03_wordmark_transparent_trimmed.png" alt="MuseCanvas" class="h-6 w-auto" />
        </div>
        <button
          class="flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] bg-primary px-5 text-sm font-medium text-white transition-all hover:bg-primary-hover"
          @click="goToLogin"
        >
          登录
          <ArrowRight class="h-3.5 w-3.5" />
        </button>
      </div>
    </nav>

    <!-- Hero -->
    <section class="relative flex min-h-screen items-center justify-center overflow-hidden pt-14">
      <!-- Background gradient -->
      <div class="absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent" />
      <div
        class="absolute top-1/4 left-1/2 h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/5 blur-[120px]"
      />

      <div class="relative z-10 mx-auto max-w-4xl px-6 text-center">
        <div
          class="mx-auto mb-8 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 backdrop-blur-sm"
        >
          <span class="h-1.5 w-1.5 rounded-full bg-primary" />
          <span class="text-xs font-medium tracking-wide text-neutral-300">AI 驱动的创意图像生成平台</span>
        </div>

        <h1 class="text-5xl font-semibold leading-tight tracking-tight text-white md:text-7xl">
          释放你的
          <span class="text-primary">创意潜能</span>
        </h1>

        <p class="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-neutral-400 md:text-xl">
          MuseCanvas 将先进的人工智能技术与直观的创作体验相结合，让每个人都能轻松将想象变为现实。
        </p>

        <div class="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
          <button
            class="flex h-12 items-center gap-2 rounded-[var(--radius-card)] bg-primary px-8 text-base font-medium text-white transition-all hover:bg-primary-hover hover:shadow-lg hover:shadow-primary/20"
            @click="goToLogin"
          >
            开始创作
            <ArrowRight class="h-4 w-4" />
          </button>
          <button
            class="flex h-12 items-center gap-2 rounded-[var(--radius-card)] border border-white/10 px-8 text-base font-medium text-neutral-300 transition-all hover:border-white/20 hover:text-white"
            @click="goToLogin"
          >
            了解更多
          </button>
        </div>
      </div>

      <!-- Scroll indicator -->
      <div class="absolute bottom-10 left-1/2 -translate-x-1/2">
        <div class="flex flex-col items-center gap-2">
          <span class="text-xs tracking-widest text-neutral-500 uppercase">向下探索</span>
          <div class="h-8 w-px bg-gradient-to-b from-neutral-500 to-transparent" />
        </div>
      </div>
    </section>

    <!-- Features -->
    <section class="relative border-t border-white/5 py-32">
      <div class="mx-auto max-w-7xl px-6">
        <div class="mb-20 text-center">
          <span class="text-xs font-medium tracking-widest text-primary uppercase">功能特性</span>
          <h2 class="mt-4 text-3xl font-semibold tracking-tight text-white md:text-4xl">为创意而生</h2>
          <p class="mx-auto mt-4 max-w-xl text-neutral-400">简洁而强大的工具，让图像生成变得前所未有的轻松</p>
        </div>

        <div class="grid gap-px bg-white/5 md:grid-cols-3">
          <div class="group bg-surface-dark p-10 transition-colors hover:bg-white/[0.02]">
            <div
              class="mb-6 flex h-12 w-12 items-center justify-center rounded-[var(--radius-control)] border border-white/10 bg-white/5"
            >
              <Sparkles class="h-5 w-5 text-primary" />
            </div>
            <h3 class="text-lg font-semibold text-white">智能生成</h3>
            <p class="mt-3 leading-relaxed text-neutral-400">
              基于先进 AI 模型，根据你的文字描述精准生成高质量图像，支持多种艺术风格。
            </p>
          </div>

          <div class="group bg-surface-dark p-10 transition-colors hover:bg-white/[0.02]">
            <div
              class="mb-6 flex h-12 w-12 items-center justify-center rounded-[var(--radius-control)] border border-white/10 bg-white/5"
            >
              <Zap class="h-5 w-5 text-primary" />
            </div>
            <h3 class="text-lg font-semibold text-white">极速响应</h3>
            <p class="mt-3 leading-relaxed text-neutral-400">
              优化的异步任务队列确保你的创作请求得到快速响应，无需漫长等待。
            </p>
          </div>

          <div class="group bg-surface-dark p-10 transition-colors hover:bg-white/[0.02]">
            <div
              class="mb-6 flex h-12 w-12 items-center justify-center rounded-[var(--radius-control)] border border-white/10 bg-white/5"
            >
              <Palette class="h-5 w-5 text-primary" />
            </div>
            <h3 class="text-lg font-semibold text-white">风格多样</h3>
            <p class="mt-3 leading-relaxed text-neutral-400">
              支持多种预设风格和参数调节，从写实到抽象，满足不同的创作需求。
            </p>
          </div>
        </div>
      </div>
    </section>

    <!-- Showcase -->
    <section class="relative border-t border-white/5 py-32">
      <div class="mx-auto max-w-7xl px-6">
        <div class="grid items-center gap-16 lg:grid-cols-2">
          <div>
            <span class="text-xs font-medium tracking-widest text-primary uppercase">工作流</span>
            <h2 class="mt-4 text-3xl font-semibold tracking-tight text-white md:text-4xl">三步开启创作</h2>
            <p class="mt-4 text-neutral-400">简化的创作流程，让你专注于创意本身</p>

            <div class="mt-12 space-y-8">
              <div class="flex gap-6">
                <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/10 text-sm font-medium text-primary">
                  01
                </div>
                <div>
                  <h4 class="text-base font-medium text-white">输入描述</h4>
                  <p class="mt-1 text-sm text-neutral-400">用自然语言描述你想要的图像，越详细越好</p>
                </div>
              </div>

              <div class="flex gap-6">
                <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/10 text-sm font-medium text-primary">
                  02
                </div>
                <div>
                  <h4 class="text-base font-medium text-white">选择风格</h4>
                  <p class="mt-1 text-sm text-neutral-400">从多种预设风格中选择，或自定义参数</p>
                </div>
              </div>

              <div class="flex gap-6">
                <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/10 text-sm font-medium text-primary">
                  03
                </div>
                <div>
                  <h4 class="text-base font-medium text-white">生成与保存</h4>
                  <p class="mt-1 text-sm text-neutral-400">一键生成，即时预览，保存到个人图库</p>
                </div>
              </div>
            </div>
          </div>

          <div class="relative">
            <div class="absolute -inset-4 rounded-[var(--radius-card)] bg-primary/5 blur-2xl" />
            <div class="relative overflow-hidden rounded-[var(--radius-card)] border border-white/10 bg-white/[0.02] p-8">
              <div class="space-y-4">
                <div class="h-3 w-24 rounded-full bg-white/10" />
                <div class="h-24 rounded-[var(--radius-card)] border border-white/5 bg-white/[0.03]" />
                <div class="flex gap-3">
                  <div class="h-8 flex-1 rounded-[var(--radius-control)] bg-primary/20" />
                  <div class="h-8 flex-1 rounded-[var(--radius-control)] border border-white/10" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- CTA -->
    <section class="relative border-t border-white/5 py-32">
      <div class="mx-auto max-w-3xl px-6 text-center">
        <h2 class="text-3xl font-semibold tracking-tight text-white md:text-5xl">准备好开始了吗？</h2>
        <p class="mt-6 text-lg text-neutral-400">加入 MuseCanvas，开启你的 AI 创作之旅</p>
        <div class="mt-10">
          <button
            class="inline-flex h-14 items-center gap-3 rounded-[var(--radius-card)] bg-primary px-10 text-lg font-medium text-white transition-all hover:bg-primary-hover hover:shadow-lg hover:shadow-primary/20"
            @click="goToLogin"
          >
            立即开始创作
            <ArrowRight class="h-5 w-5" />
          </button>
        </div>
      </div>
    </section>

    <!-- Footer -->
    <footer class="border-t border-white/5 py-8">
      <div class="mx-auto flex max-w-7xl items-center justify-between px-6">
        <div class="flex items-center gap-2">
          <img src="/brand/musecanvas_flow_ribbon_final_pack/03_transparent_trimmed_png/04_monochrome_logo_transparent_trimmed.png" alt="MuseCanvas" class="h-6 w-auto opacity-60" />
        </div>
        <p class="text-xs text-neutral-600">&copy; 2025 MuseCanvas. All rights reserved.</p>
      </div>
    </footer>
  </div>
</template>
