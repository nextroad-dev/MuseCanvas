<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import { useLibraryStore } from '@/features/library/stores/library'
import { useGenerationStore } from '@/features/generate/stores/generation'
import ImageCard from '@/shared/components/ui/ImageCard.vue'
import EmptyState from '@/shared/components/ui/EmptyState.vue'
import ConfirmDialog from '@/shared/components/ui/ConfirmDialog.vue'
import Lightbox from '@/shared/components/ui/Lightbox.vue'
import SkeletonBlock from '@/shared/components/ui/SkeletonBlock.vue'
import type { Asset } from '@/shared/types'
import { useClickOutside } from '@/shared/composables/useClickOutside'

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

/* dropdown open state */
const openDropdown = ref<string | null>(null)

/* ------------------------------------------------------------------ */
/*  options                                                            */
/* ------------------------------------------------------------------ */
const columnOptions: { value: ColumnCount; label: string }[] = [
  { value: 2, label: '2 列' },
  { value: 3, label: '3 列' },
  { value: 4, label: '4 列' },
  { value: 5, label: '5 列' },
  { value: 6, label: '6 列' },
]

const rowOptions: { value: RowCount; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 2, label: '2 行' },
  { value: 3, label: '3 行' },
  { value: 4, label: '4 行' },
  { value: 5, label: '5 行' },
  { value: 'all', label: '全部显示' },
]

const photoSizeOptions: { value: PhotoSize; label: string }[] = [
  { value: 'small', label: '小' },
  { value: 'medium', label: '中' },
  { value: 'large', label: '大' },
  { value: 'xlarge', label: '超大' },
]

/* ------------------------------------------------------------------ */
/*  computed                                                           */
/* ------------------------------------------------------------------ */
const rowCountLabel = computed(() => {
  const found = rowOptions.find(o => o.value === rowCount.value)
  return found?.label ?? '自动'
})

const photoSizeLabel = computed(() => {
  const found = photoSizeOptions.find(o => o.value === photoSize.value)
  return found?.label ?? '中'
})

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
  openDropdown.value = null
}

function selectRow(val: RowCount) {
  rowCount.value = val
  writeStorage(STORAGE_KEYS.rowCount, val)
  openDropdown.value = null
}

function selectPhotoSize(val: PhotoSize) {
  photoSize.value = val
  writeStorage(STORAGE_KEYS.photoSize, val)
  openDropdown.value = null
}

/* click outside to close dropdowns */
function closeDropdowns() {
  openDropdown.value = null
}

/* ------------------------------------------------------------------ */
/*  lifecycle                                                          */
/* ------------------------------------------------------------------ */
const toolbarRef = ref<HTMLElement>()

useClickOutside(toolbarRef, closeDropdowns)

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

function handleDownload(asset: Asset) {
  const a = document.createElement('a')
  a.href = asset.imageUrl
  a.download = `musecanvas-${asset.id}.png`
  a.click()
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
    <div
      ref="toolbarRef"
      class="flex min-h-12 shrink-0 items-center justify-end gap-2 border-b border-border px-4 py-2 sm:px-6"
    >
      <!-- Column count -->
      <div class="relative">
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-[var(--radius-control)] border border-transparent px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle"
          @click.stop="openDropdown = openDropdown === 'column' ? null : 'column'"
        >
          列数 {{ columnCount }}
          <ChevronDown
            class="h-3.5 w-3.5 text-muted-foreground transition-transform duration-200"
            :class="openDropdown === 'column' ? 'rotate-180' : ''"
          />
        </button>
        <div
          v-if="openDropdown === 'column'"
          class="absolute right-0 top-full z-50 mt-1 min-w-[120px] rounded-[var(--radius-card)] border border-border bg-surface p-1 shadow-md"
          @click.stop
        >
          <button
            v-for="opt in columnOptions"
            :key="opt.value"
            type="button"
            class="flex w-full items-center rounded-[var(--radius-control)] px-2 py-1.5 text-left text-xs transition-colors hover:bg-surface-subtle"
            :class="columnCount === opt.value ? 'bg-primary-soft text-primary' : 'text-foreground'"
            @click="selectColumn(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>

      <!-- Row count -->
      <div class="relative">
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-[var(--radius-control)] border border-transparent px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle"
          @click.stop="openDropdown = openDropdown === 'row' ? null : 'row'"
        >
          行数 {{ rowCountLabel }}
          <ChevronDown
            class="h-3.5 w-3.5 text-muted-foreground transition-transform duration-200"
            :class="openDropdown === 'row' ? 'rotate-180' : ''"
          />
        </button>
        <div
          v-if="openDropdown === 'row'"
          class="absolute right-0 top-full z-50 mt-1 min-w-[120px] rounded-[var(--radius-card)] border border-border bg-surface p-1 shadow-md"
          @click.stop
        >
          <button
            v-for="opt in rowOptions"
            :key="String(opt.value)"
            type="button"
            class="flex w-full items-center rounded-[var(--radius-control)] px-2 py-1.5 text-left text-xs transition-colors hover:bg-surface-subtle"
            :class="rowCount === opt.value ? 'bg-primary-soft text-primary' : 'text-foreground'"
            @click="selectRow(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>

      <!-- Photo size -->
      <div class="relative">
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-[var(--radius-control)] border border-transparent px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle"
          @click.stop="openDropdown = openDropdown === 'size' ? null : 'size'"
        >
          大小 {{ photoSizeLabel }}
          <ChevronDown
            class="h-3.5 w-3.5 text-muted-foreground transition-transform duration-200"
            :class="openDropdown === 'size' ? 'rotate-180' : ''"
          />
        </button>
        <div
          v-if="openDropdown === 'size'"
          class="absolute right-0 top-full z-50 mt-1 min-w-[120px] rounded-[var(--radius-card)] border border-border bg-surface p-1 shadow-md"
          @click.stop
        >
          <button
            v-for="opt in photoSizeOptions"
            :key="opt.value"
            type="button"
            class="flex w-full items-center rounded-[var(--radius-control)] px-2 py-1.5 text-left text-xs transition-colors hover:bg-surface-subtle"
            :class="photoSize === opt.value ? 'bg-primary-soft text-primary' : 'text-foreground'"
            @click="selectPhotoSize(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
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
