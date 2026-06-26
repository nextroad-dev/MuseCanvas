<script setup lang="ts">
import { RouterLink, useRouter } from 'vue-router'
import { ArrowRight, Brush, Check, Layers3, Library, PanelTop, Sparkles, WandSparkles, Zap } from 'lucide-vue-next'
import FlowLinesBg from '@/shared/components/FlowLinesBg.vue'
import MatrixBg from '@/shared/components/MatrixBg.vue'
import BaseButton from '@/shared/components/ui/BaseButton.vue'

const router = useRouter()

const canvasTiles = [
  { title: 'Prompt', text: '雨后城市屋顶，薄雾，胶片质感' },
  { title: 'Thinking', text: '模型前置思考，自动选择提示词模板' },
  { title: 'Queue', text: '生成中 68%' },
]

const featureCards = [
  {
    title: '从一句话开始',
    description: '把灵感、构图和情绪写成提示词，MuseCanvas 会通过前置思考把它整理成可生成的视觉方向。',
    icon: WandSparkles,
  },
  {
    title: '模板自动适配',
    description: '用户不需要手动挑选风格模板，模型会根据提示词意图自动匹配合适的前处理模板。',
    icon: PanelTop,
  },
  {
    title: '作品自然沉淀',
    description: '生成结果、任务状态和历史记录自动进入图库，方便回看、下载和继续迭代。',
    icon: Library,
  },
]

const workflowSteps = [
  {
    title: '描述画面',
    description: '用自然语言写下主体、场景、材质、光线和想要避开的元素。',
  },
  {
    title: '确定输出',
    description: '选择模型、画幅和生成数量，前置思考会在提交后自动完成模板匹配。',
  },
  {
    title: '归档复用',
    description: '保存作品和最终提示词，把一次灵感变成之后可以继续使用的创作资产。',
  },
]

function goToLogin() {
  router.push('/login')
}
</script>

<template>
  <div class="min-h-screen bg-canvas text-foreground antialiased">
    <nav class="fixed inset-x-0 top-0 z-50 border-b border-border bg-surface/90 backdrop-blur-md">
      <div class="mx-auto flex h-14 max-w-[1440px] items-center justify-between px-4 sm:px-6">
        <RouterLink to="/" class="flex items-center rounded-[var(--radius-control)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-soft">
          <img
            src="/brand/musecanvas_flow_ribbon_final_pack/03_transparent_trimmed_png/03_wordmark_transparent_trimmed.png"
            alt="MuseCanvas"
            class="h-6 w-auto"
          />
        </RouterLink>
        <div class="flex items-center gap-2">
          <RouterLink
            to="/terms"
            class="hidden rounded-[var(--radius-control)] px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-soft sm:inline-flex"
          >
            用户协议
          </RouterLink>
          <BaseButton size="sm" @click="goToLogin">
            登录
            <ArrowRight class="h-3.5 w-3.5" aria-hidden="true" />
          </BaseButton>
        </div>
      </div>
    </nav>

    <main>
      <section class="relative isolate flex min-h-[calc(100svh-48px)] items-center overflow-hidden px-4 pb-12 pt-24 sm:px-6 sm:pt-28">
        <div class="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,var(--color-border)_1px,transparent_1px),linear-gradient(to_bottom,var(--color-border)_1px,transparent_1px)] bg-[size:72px_72px] opacity-30" />
        <FlowLinesBg class="opacity-75" :density="0.8" :speed="0.38" :layers="4" :line-width="1" />
        <MatrixBg class="opacity-20" :grid-spacing="68" :dot-size="1.1" :line-opacity="0.05" :dot-opacity="0.18" :pulse-speed="0.5" :speed="0.45" />
        <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_28%,var(--color-primary-soft)_0%,transparent_32%),linear-gradient(to_bottom,var(--color-canvas)_0%,transparent_20%,transparent_72%,var(--color-canvas)_100%)]" />

        <div class="relative z-10 mx-auto grid w-full max-w-[1440px] gap-10 lg:grid-cols-[minmax(0,0.92fr)_minmax(420px,0.68fr)] lg:items-center">
          <div class="mx-auto max-w-4xl text-center lg:mx-0 lg:text-left">
            <h1 class="text-[36px] font-semibold leading-[1.08] text-foreground sm:text-[56px]">
              MuseCanvas
              <span class="block text-primary">把灵感整理成可生成的画面</span>
            </h1>

            <p class="mx-auto mt-6 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg lg:mx-0">
              面向创作者的 AI 图像工作台。从提示词、模型前置思考到任务历史和作品图库，保持在同一条清晰的创作路径里。
            </p>

            <div class="mt-8 flex flex-col items-center gap-3 sm:flex-row lg:justify-start">
              <BaseButton size="lg" @click="goToLogin">
                开始创作
                <template #icon>
                  <Sparkles class="h-4 w-4" aria-hidden="true" />
                </template>
              </BaseButton>
              <a
                href="#workflow"
                class="inline-flex h-12 items-center justify-center rounded-[var(--radius-control)] border border-border bg-surface px-6 text-sm font-medium text-foreground transition-colors hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-soft"
              >
                查看流程
              </a>
            </div>
          </div>

          <div class="relative mx-auto hidden w-full max-w-[520px] lg:block" aria-hidden="true">
            <div class="absolute -left-8 top-8 h-20 w-32 rounded-[var(--radius-panel)] border border-border bg-surface/80 shadow-sm backdrop-blur-sm" />
            <div class="absolute -right-6 bottom-12 h-24 w-24 rounded-[var(--radius-panel)] border border-primary/20 bg-primary-soft/70 shadow-sm backdrop-blur-sm" />
            <div class="relative overflow-hidden rounded-[var(--radius-panel)] border border-border bg-surface/88 p-4 shadow-md backdrop-blur-md">
              <div class="flex items-center justify-between border-b border-border pb-3">
                <div class="flex items-center gap-2">
                  <span class="flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] bg-primary-soft text-primary">
                    <Brush class="h-4 w-4" />
                  </span>
                  <span class="text-sm font-semibold">创作控制台</span>
                </div>
                <span class="rounded-full bg-success-soft px-2.5 py-1 text-xs font-medium text-success">就绪</span>
              </div>

              <div class="grid gap-3 py-4">
                <div
                  v-for="tile in canvasTiles"
                  :key="tile.title"
                  class="rounded-[var(--radius-card)] border border-border bg-surface-subtle p-4"
                >
                  <div class="mb-2 flex items-center justify-between">
                    <span class="text-xs font-medium text-muted-foreground">{{ tile.title }}</span>
                    <Check class="h-3.5 w-3.5 text-primary" />
                  </div>
                  <p class="text-sm leading-6 text-foreground">{{ tile.text }}</p>
                </div>
              </div>

              <div class="grid grid-cols-3 gap-3 border-t border-border pt-4">
                <div class="aspect-square rounded-[var(--radius-card)] bg-primary-soft p-3">
                  <Layers3 class="h-4 w-4 text-primary" />
                  <div class="mt-8 h-2 rounded-full bg-primary/20" />
                </div>
                <div class="aspect-square rounded-[var(--radius-card)] border border-border bg-background p-3">
                  <Zap class="h-4 w-4 text-primary" />
                  <div class="mt-8 h-2 rounded-full bg-surface-subtle" />
                </div>
                <div class="aspect-square rounded-[var(--radius-card)] border border-border bg-background p-3">
                  <Library class="h-4 w-4 text-primary" />
                  <div class="mt-8 h-2 rounded-full bg-surface-subtle" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="border-y border-border bg-surface">
        <div class="mx-auto grid max-w-[1440px] gap-px bg-border md:grid-cols-3">
          <article
            v-for="feature in featureCards"
            :key="feature.title"
            class="bg-surface p-6 transition-colors hover:bg-surface-subtle sm:p-8"
          >
            <div class="mb-5 flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] border border-border bg-surface-subtle text-primary">
              <component :is="feature.icon" class="h-5 w-5" aria-hidden="true" />
            </div>
            <h2 class="text-lg font-semibold leading-7 text-foreground">{{ feature.title }}</h2>
            <p class="mt-3 max-w-md text-sm leading-6 text-muted-foreground">{{ feature.description }}</p>
          </article>
        </div>
      </section>

      <section id="workflow" class="relative overflow-hidden px-4 py-20 sm:px-6 sm:py-28">
        <FlowLinesBg class="opacity-25" :density="0.32" :speed="0.22" :layers="2" :line-width="0.8" />
        <div class="pointer-events-none absolute inset-0 bg-gradient-to-r from-canvas via-canvas/90 to-canvas" />

        <div class="relative mx-auto grid max-w-[1440px] gap-10 lg:grid-cols-[0.72fr_1fr] lg:items-start">
          <div class="max-w-xl">
            <p class="text-sm font-medium text-primary">创作路径</p>
            <h2 class="mt-3 text-[28px] font-semibold leading-[1.2] text-foreground sm:text-[36px]">不把灵感塞进表单，而是放进流程</h2>
            <p class="mt-4 text-sm leading-6 text-muted-foreground sm:text-base">
              首页之后进入的不是复杂后台，而是一个专注的生成工作区。你只需要描述画面，模型会先理解意图并自动选择合适模板，再进入生成、结果和历史沉淀。
            </p>
          </div>

          <div class="grid gap-4">
            <article
              v-for="(step, index) in workflowSteps"
              :key="step.title"
              class="grid gap-4 rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-sm sm:grid-cols-[72px_1fr] sm:p-6"
            >
              <div class="flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold tabular-nums text-primary sm:h-14 sm:w-14">
                {{ String(index + 1).padStart(2, '0') }}
              </div>
              <div>
                <h3 class="text-base font-semibold leading-6 text-foreground">{{ step.title }}</h3>
                <p class="mt-2 text-sm leading-6 text-muted-foreground">{{ step.description }}</p>
              </div>
            </article>
          </div>
        </div>
      </section>

      <section class="border-t border-border bg-surface px-4 py-16 sm:px-6 sm:py-20">
        <div class="mx-auto flex max-w-[1120px] flex-col items-start justify-between gap-8 md:flex-row md:items-center">
          <div>
            <h2 class="text-[28px] font-semibold leading-[1.2] text-foreground sm:text-[36px]">准备让第一张图成形？</h2>
            <p class="mt-3 max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
              登录后即可进入创作台，输入提示词、选择基础输出参数，并把生成结果保存到你的图库。
            </p>
          </div>
          <BaseButton size="lg" @click="goToLogin">
            进入 MuseCanvas
            <ArrowRight class="h-4 w-4" aria-hidden="true" />
          </BaseButton>
        </div>
      </section>
    </main>

    <footer class="border-t border-border bg-canvas py-8">
      <div class="mx-auto flex max-w-[1440px] flex-col items-center justify-between gap-4 px-4 text-center sm:flex-row sm:px-6 sm:text-left">
        <img
          src="/brand/musecanvas_flow_ribbon_final_pack/03_transparent_trimmed_png/04_monochrome_logo_transparent_trimmed.png"
          alt="MuseCanvas"
          class="h-6 w-auto opacity-70"
        />
        <div class="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <RouterLink to="/terms" class="transition-colors hover:text-foreground">用户协议</RouterLink>
          <RouterLink to="/privacy" class="transition-colors hover:text-foreground">隐私政策</RouterLink>
          <span>&copy; 2026 MuseCanvas. All rights reserved.</span>
        </div>
      </div>
    </footer>
  </div>
</template>
