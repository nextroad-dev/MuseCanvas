<script setup lang="ts">
import { RouterView } from 'vue-router'
import ToastProvider from '@/shared/components/ui/ToastProvider.vue'
</script>

<template>
  <ToastProvider />
  <RouterView />
</template>
