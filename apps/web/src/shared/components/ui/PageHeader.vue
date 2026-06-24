<script setup lang="ts">

withDefaults(defineProps<{
  title: string
  description?: string
  eyebrow?: string
}>(), {
  description: '',
  eyebrow: '',
})
</script>

<template>
  <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
    <div class="min-w-0 flex-1">
      <span v-if="eyebrow" class="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {{ eyebrow }}
      </span>
      <h1 :id="title" class="text-xl font-semibold tracking-[-0.02em] text-foreground sm:text-2xl">
        {{ title }}
      </h1>
      <p v-if="description" class="mt-1 text-sm text-muted-foreground">
        {{ description }}
      </p>
    </div>
    <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
