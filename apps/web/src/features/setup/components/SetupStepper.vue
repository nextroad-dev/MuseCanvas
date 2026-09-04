<script setup lang="ts">
import { computed } from 'vue'
import type { SetupStep } from '../lib/steps'

const props = defineProps<{
  steps: SetupStep[]
  currentId: SetupStep['id']
  completed: Record<string, boolean>
}>()

const currentIndex = computed(() => Math.max(0, props.steps.findIndex((s) => s.id === props.currentId)))
const progress = computed(() => Math.round(((currentIndex.value + 1) / props.steps.length) * 100))
const currentStep = computed(() => props.steps[currentIndex.value])
</script>

<template>
  <nav aria-label="初始化进度" class="w-full">
    <p class="mb-2 text-center text-xs text-muted-foreground sm:hidden" aria-live="polite">
      第 {{ currentIndex + 1 }} / {{ steps.length }} 步：{{ currentStep?.label }}
      <span v-if="currentStep?.optional">（可选）</span>
    </p>
    <div
      class="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-subtle"
      role="progressbar"
      :aria-valuenow="currentIndex + 1"
      :aria-valuemin="1"
      :aria-valuemax="steps.length"
      :aria-label="`初始化进度：第 ${currentIndex + 1} 步，共 ${steps.length} 步`"
    >
      <div class="h-full rounded-full bg-primary transition-all" :style="{ width: `${progress}%` }" />
    </div>
    <ol class="flex flex-wrap items-start justify-center gap-x-1 gap-y-2 sm:gap-x-2">
      <li
        v-for="(step, i) in steps"
        :key="step.id"
        class="flex min-w-0 items-center"
        :aria-current="step.id === currentId ? 'step' : undefined"
      >
        <span class="flex items-center gap-1.5">
          <span
            :class="[
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-medium transition-colors sm:h-8 sm:w-8 sm:text-sm',
              step.id === currentId
                ? 'bg-primary text-primary-foreground'
                : completed[step.id]
                  ? 'bg-success text-white'
                  : 'bg-surface-subtle text-muted-foreground',
            ]"
            aria-hidden="true"
          >
            {{ completed[step.id] && step.id !== currentId ? '✓' : i + 1 }}
          </span>
          <span
            :class="[
              'hidden text-xs sm:inline',
              step.id === currentId ? 'font-medium text-foreground' : 'text-muted-foreground',
            ]"
          >
            {{ step.label }}
            <span v-if="step.optional" class="text-muted-foreground">·可选</span>
          </span>
        </span>
        <span v-if="i < steps.length - 1" class="mx-1 h-px w-3 bg-border sm:w-6" aria-hidden="true" />
      </li>
    </ol>
  </nav>
</template>
