<script setup lang="ts">
import { RouterLink, useRouter } from 'vue-router'
import { ArrowRight, Brush, Check, Layers3, Library, PanelTop, Sparkles, WandSparkles, Zap } from 'lucide-vue-next'
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

const capabilities = [
  { icon: WandSparkles, label: '提示词前置思考' },
  { icon: Layers3, label: '多模型与画幅' },
  { icon: Zap, label: '任务队列与重试' },
  { icon: Library, label: '图库与历史沉淀' },
]

function goToLogin() {
  router.push('/login')
}
</script>

<template>
  <div class="min-h-screen bg-canvas text-foreground antialiased">
    <nav class="sticky inset-x-0 top-0 z-50 border-b border-border bg-surface">
      <div class="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-4 sm:px-6">
        <RouterLink to="/" class="flex items-center rounded-[var(--radius-control)]" aria-label="MuseCanvas 首页">
          <img
            src="/brand/musecanvas_flow_ribbon_final_pack/03_transparent_trimmed_png/03_wordmark_transparent_trimmed.png"
            alt="MuseCanvas"
            class="h-6 w-auto"
          />
        </RouterLink>
        <div class="flex items-center gap-2">
          <RouterLink
            to="/terms"
            class="hidden min-h-10 items-center rounded-[var(--radius-control)] px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground sm:inline-flex"
          >
            用户协议
          </RouterLink>
          <BaseButton size="md" @click="goToLogin">
            登录
            <ArrowRight class="h-4 w-4" aria-hidden="true" />
          </BaseButton>
        </div>
      </div>
    </nav>

    <main>
      <!-- Hero: type and whitespace carry the hierarchy. -->
      <section class="border-b border-border">
        <div class="mx-auto grid max-w-[1200px] gap-12 px-4 py-20 sm:px-6 sm:py-24 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.7fr)] lg:items-start lg:py-28">
          <div class="max-w-3xl">
            <p class="mb-5 inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1 text-xs font-medium text-accent-strong">
              <Sparkles class="h-3.5 w-3.5" aria-hidden="true" />
              AI 图像工作台
            </p>

            <h1 class="text-display font-normal leading-[1.05] tracking-[-0.0175em] text-foreground">
              MuseCanvas
              <span class="mt-2 block text-muted-foreground">把灵感整理成可生成的画面</span>
            </h1>

            <p class="mt-7 max-w-2xl text-base leading-[1.59] text-muted-foreground">
              面向创作者的 AI 图像工作台。从提示词、模型前置思考到任务历史和作品图库，保持在同一条清晰的创作路径里。
            </p>

            <div class="mt-9 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
              <BaseButton size="lg" @click="goToLogin">
                开始创作
                <template #icon>
                  <Sparkles class="h-4 w-4" aria-hidden="true" />
                </template>
              </BaseButton>
              <a
                href="#workflow"
                class="inline-flex min-h-12 items-center justify-center rounded-[var(--radius-control)] border border-border-control bg-surface px-6 text-sm font-medium text-foreground transition-colors hover:bg-surface-subtle"
              >
                查看流程
              </a>
            </div>

            <ul class="mt-10 flex flex-wrap gap-x-6 gap-y-3">
              <li v-for="capability in capabilities" :key="capability.label" class="flex items-center gap-2 text-sm text-muted-foreground">
                <component :is="capability.icon" class="h-4 w-4 text-accent-strong" aria-hidden="true" />
                {{ capability.label }}
              </li>
            </ul>
          </div>

          <!-- Product preview: a plain surface, no glass, no decoration. -->
          <div class="w-full rounded-[var(--radius-panel)] border border-border bg-surface p-5">
            <div class="flex items-center justify-between border-b border-border pb-4">
              <div class="flex items-center gap-2">
                <span class="flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] bg-accent-soft text-accent-strong">
                  <Brush class="h-4 w-4" aria-hidden="true" />
                </span>
                <span class="text-sm font-medium">创作控制台</span>
              </div>
              <span class="rounded-full bg-success-soft px-2.5 py-1 text-xs font-medium text-success">就绪</span>
            </div>

            <dl class="divide-y divide-border">
              <div v-for="tile in canvasTiles" :key="tile.title" class="py-4">
                <dt class="mb-1.5 flex items-center justify-between text-xs font-medium text-muted-foreground">
                  {{ tile.title }}
                  <Check class="h-3.5 w-3.5 text-accent-strong" aria-hidden="true" />
                </dt>
                <dd class="text-sm leading-[1.59] text-foreground">{{ tile.text }}</dd>
              </div>
            </dl>

            <div class="grid grid-cols-3 gap-3 border-t border-border pt-4">
              <div class="rounded-[var(--radius-card)] bg-accent-soft p-3">
                <Layers3 class="h-4 w-4 text-accent-strong" aria-hidden="true" />
                <div class="mt-6 h-1.5 rounded-full bg-accent/25" />
              </div>
              <div class="rounded-[var(--radius-card)] border border-border bg-canvas p-3">
                <Zap class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <div class="mt-6 h-1.5 rounded-full bg-surface-subtle-strong" />
              </div>
              <div class="rounded-[var(--radius-card)] border border-border bg-canvas p-3">
                <Library class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <div class="mt-6 h-1.5 rounded-full bg-surface-subtle-strong" />
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Features: tonal band with dividers instead of stacked cards. -->
      <section class="border-b border-border bg-surface-subtle">
        <div class="mx-auto grid max-w-[1200px] divide-y divide-border px-4 sm:px-6 md:grid-cols-3 md:divide-x md:divide-y-0">
          <article
            v-for="feature in featureCards"
            :key="feature.title"
            class="py-8 md:px-8 md:first:pl-0 md:last:pr-0"
          >
            <div class="mb-5 flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] border border-border bg-surface text-accent-strong">
              <component :is="feature.icon" class="h-5 w-5" aria-hidden="true" />
            </div>
            <h2 class="text-subtitle font-normal leading-[1.4] text-foreground">{{ feature.title }}</h2>
            <p class="mt-3 max-w-md text-sm leading-[1.59] text-muted-foreground">{{ feature.description }}</p>
          </article>
        </div>
      </section>

      <section id="workflow" class="border-b border-border">
        <div class="mx-auto grid max-w-[1200px] gap-12 px-4 py-20 sm:px-6 sm:py-24 lg:grid-cols-[0.75fr_1fr] lg:items-start">
          <div class="max-w-xl">
            <p class="text-sm font-medium text-accent-strong">创作路径</p>
            <h2 class="mt-3 text-section font-normal leading-[1.35] text-foreground">不把灵感塞进表单，而是放进流程</h2>
            <p class="mt-4 text-base leading-[1.59] text-muted-foreground">
              首页之后进入的不是复杂后台，而是一个专注的生成工作区。你只需要描述画面，模型会先理解意图并自动选择合适模板，再进入生成、结果和历史沉淀。
            </p>
          </div>

          <ol class="divide-y divide-border border-t border-border">
            <li
              v-for="(step, index) in workflowSteps"
              :key="step.title"
              class="grid gap-4 py-6 sm:grid-cols-[56px_1fr]"
            >
              <span class="flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-sm font-medium tabular-nums text-accent-strong">
                {{ String(index + 1).padStart(2, '0') }}
              </span>
              <div>
                <h3 class="text-base font-medium leading-[1.5] text-foreground">{{ step.title }}</h3>
                <p class="mt-2 text-sm leading-[1.59] text-muted-foreground">{{ step.description }}</p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      <section class="bg-surface-subtle px-4 py-16 sm:px-6 sm:py-20">
        <div class="mx-auto flex max-w-[1200px] flex-col items-start justify-between gap-8 md:flex-row md:items-center">
          <div>
            <h2 class="text-section font-normal leading-[1.35] text-foreground">准备让第一张图成形？</h2>
            <p class="mt-3 max-w-xl text-base leading-[1.59] text-muted-foreground">
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

    <footer class="border-t border-border bg-surface py-8">
      <div class="mx-auto flex max-w-[1200px] flex-col items-center justify-between gap-4 px-4 text-center sm:flex-row sm:px-6 sm:text-left">
        <img
          src="/brand/musecanvas_flow_ribbon_final_pack/03_transparent_trimmed_png/04_monochrome_logo_transparent_trimmed.png"
          alt="MuseCanvas"
          class="h-6 w-auto"
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