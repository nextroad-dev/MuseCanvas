<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useLibraryStore } from '@/features/library/stores/library'
import { useGenerationStore } from '@/features/generate/stores/generation'
import ImageCard from '@/shared/components/ui/ImageCard.vue'
import EmptyState from '@/shared/components/ui/EmptyState.vue'
import ConfirmDialog from '@/shared/components/ui/ConfirmDialog.vue'
import Lightbox from '@/shared/components/ui/Lightbox.vue'
import SkeletonBlock from '@/shared/components/ui/SkeletonBlock.vue'
import { ZoomIn, ZoomOut } from 'lucide-vue-next'
import type { Asset } from '@/shared/types'

/* ------------------------------------------------------------------ */
/*  localStorage helpers                                               */
/* ------------------------------------------------------------------ */
function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw !== null) return JSON.parse(raw) as T
  } catch {
    // ignore
  }
  return fallback
}

function writeStorage<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore
  }
}

/* ------------------------------------------------------------------ */
/*  types & state                                                      */
/* ------------------------------------------------------------------ */
type ColumnCount = 2 | 3 | 4 | 5 | 6
type RowCount = 'auto' | 2 | 3 | 4 | 5 | 'all'
type PhotoSize = 'small' | 'medium' | 'large' | 'xlarge'

const STORAGE_KEYS = {
  columnCount: 'musecanvas.gallery.columnCount',
  rowCount: 'musecanvas.gallery.rowCount',
  photoSize: 'musecanvas.gallery.photoSize',
} as const

const library = useLibraryStore()
const generation = useGenerationStore()
const deleteTarget = ref<Asset | null>(null)
const showDeleteConfirm = ref(false)
const lightboxIndex = ref(-1)

/* view controls */
const columnCount = ref<ColumnCount>(
  readStorage<ColumnCount>(STORAGE_KEYS.columnCount, 4),
)
const rowCount = ref<RowCount>(
  readStorage<RowCount>(STORAGE_KEYS.rowCount, 'auto'),
)
const photoSize = ref<PhotoSize>(
  readStorage<PhotoSize>(STORAGE_KEYS.photoSize, 'medium'),
)



/* ------------------------------------------------------------------ */
/*  options                                                            */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/*  computed                                                           */
/* ------------------------------------------------------------------ */

/* responsive column classes: mobile caps at 2, tablet at 4 */
const columnGridClass = computed(() => {
  const cols = columnCount.value
  if (cols === 2) return 'grid-cols-2'
  if (cols === 3) return 'grid-cols-2 md:grid-cols-3'
  if (cols === 4) return 'grid-cols-2 md:grid-cols-4'
  if (cols === 5) return 'grid-cols-2 md:grid-cols-4 lg:grid-cols-5'
  return 'grid-cols-2 md:grid-cols-4 lg:grid-cols-6'
})

const gapClass = computed(() => {
  if (photoSize.value === 'small') return 'gap-3'
  if (photoSize.value === 'xlarge') return 'gap-6'
  return 'gap-4'
})

const gridClass = computed(() => {
  return `grid ${columnGridClass.value} ${gapClass.value}`
})

/* row count limits visible items when not auto/all */
const displayedAssets = computed(() => {
  if (rowCount.value === 'auto' || rowCount.value === 'all') {
    return library.assets
  }
  const limit = columnCount.value * rowCount.value
  return library.assets.slice(0, limit)
})

const lightboxImages = computed(() =>
  library.assets.map(a => ({ url: a.imageUrl, prompt: a.prompt, alt: a.prompt })),
)

/* ------------------------------------------------------------------ */
/*  dropdown helpers                                                   */
/* ------------------------------------------------------------------ */
function selectColumn(val: ColumnCount) {
  columnCount.value = val
  writeStorage(STORAGE_KEYS.columnCount, val)
}



/* ------------------------------------------------------------------ */
/*  lifecycle                                                          */
/* ------------------------------------------------------------------ */
onMounted(() => {
  library.fetchAssets()
})

/* ------------------------------------------------------------------ */
/*  handlers                                                           */
/* ------------------------------------------------------------------ */
function handleView(asset: Asset) {
  const index = library.assets.findIndex(a => a.id === asset.id)
  if (index >= 0) {
    lightboxIndex.value = index
  }
}

async function handleDownload(asset: Asset) {
  try {
    const response = await fetch(asset.imageUrl)
    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)
    
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = `musecanvas-${asset.id}.png`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
  } catch (error) {
    console.error('Failed to download image:', error)
    window.open(asset.imageUrl, '_blank')
  }
}

function handleDelete(asset: Asset) {
  deleteTarget.value = asset
  showDeleteConfirm.value = true
}

async function confirmDelete() {
  if (deleteTarget.value) {
    const res = await library.deleteAsset(deleteTarget.value.id)
    if (res.success) await generation.fetchJobs()
  }
  showDeleteConfirm.value = false
  deleteTarget.value = null
}
</script>

<template>
  <div class="flex h-full w-full flex-col">
    <h1 class="sr-only">图库</h1>
    <!-- Toolbar -->
    <div class="flex min-h-12 shrink-0 items-center justify-end gap-2 border-b border-border px-4 py-2 sm:px-6">
      <div class="flex items-center gap-1 rounded-[var(--radius-control)] border border-border bg-surface p-1 shadow-sm">
        <button
          class="inline-flex h-8 w-8 items-center justify-center rounded-[calc(var(--radius-control)-4px)] text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground disabled:opacity-50"
          :disabled="columnCount >= 6"
          @click="selectColumn(Math.min(6, columnCount + 1) as ColumnCount)"
          title="缩小网格"
        >
          <ZoomOut class="h-4 w-4" />
        </button>
        <div class="h-4 w-px bg-border"></div>
        <button
          class="inline-flex h-8 w-8 items-center justify-center rounded-[calc(var(--radius-control)-4px)] text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground disabled:opacity-50"
          :disabled="columnCount <= 2"
          @click="selectColumn(Math.max(2, columnCount - 1) as ColumnCount)"
          title="放大网格"
        >
          <ZoomIn class="h-4 w-4" />
        </button>
      </div>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-auto p-4 sm:p-6">
      <EmptyState
        v-if="!library.loading && library.assets.length === 0"
        title="暂无图片"
        description="生成后的作品会出现在这里"
        @action="() => {}"
      >
        <template #action-label>去创作</template>
      </EmptyState>

      <!-- Loading skeleton -->
      <div v-else-if="library.loading" :class="gridClass">
        <SkeletonBlock
          v-for="i in 8"
          :key="i"
          variant="image"
          class="aspect-square"
        />
      </div>

      <!-- Image grid -->
      <div v-else :class="gridClass">
        <ImageCard
          v-for="asset in displayedAssets"
          :key="asset.id"
          :asset="asset"
          :photo-size="photoSize"
          @view="handleView"
          @download="handleDownload"
          @delete="handleDelete"
        />
      </div>
    </div>

    <!-- Lightbox -->
    <Lightbox :images="lightboxImages" v-model="lightboxIndex" />

    <!-- Delete confirmation -->
    <ConfirmDialog
      v-model:open="showDeleteConfirm"
      title="删除图片"
      description="此操作会同步删除对应任务历史和同任务生成的图片。"
      confirm-text="删除"
      variant="danger"
      @confirm="confirmDelete"
    />
  </div>
</template>
