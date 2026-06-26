export type SizeDisplay = {
  value: string
  width: number
  height: number
  ratio: string
  ratioDesc: string
  resolution: string
}

const ratioDescs: Record<string, string> = {
  '1:1': '正方形',
  '4:3': '常规横图',
  '3:4': '常规竖图',
  '16:9': '横屏封面 / PPT',
  '9:16': '手机壁纸 / 竖屏海报',
  '3:2': '摄影横图',
  '2:3': '摄影竖图',
  '21:9': '超宽横图',
}

const commonRatios = [
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
  { label: '3:2', value: 3 / 2 },
  { label: '2:3', value: 2 / 3 },
  { label: '21:9', value: 21 / 9 },
]

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

function fallbackRatio(width: number, height: number): string {
  const divisor = gcd(width, height)
  return `${width / divisor}:${height / divisor}`
}

function ratioLabel(width: number, height: number): string {
  const ratio = width / height
  const match = commonRatios.find(item => Math.abs(item.value - ratio) <= 0.06)
  return match?.label || fallbackRatio(width, height)
}

function resolutionLabel(width: number, height: number): string {
  const pixels = width * height
  if (pixels >= 12_000_000) return '4K'
  if (pixels >= 8_000_000) return '3K'
  if (pixels >= 3_000_000) return '2K'
  return '1K'
}

export function parseSizeDisplay(size: string): SizeDisplay | null {
  const match = size.match(/^(\d+)x(\d+)$/)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null
  const ratio = ratioLabel(width, height)
  return {
    value: size,
    width,
    height,
    ratio,
    ratioDesc: ratioDescs[ratio] || '自定义比例',
    resolution: resolutionLabel(width, height),
  }
}

export function selectedRatio(size: string): string {
  return parseSizeDisplay(size)?.ratio || size
}

export function selectedResolution(size: string): string {
  return parseSizeDisplay(size)?.resolution || size
}

export function ratioOptions(sizes: string[]) {
  const seen = new Set<string>()
  return sizes.flatMap((size) => {
    const display = parseSizeDisplay(size)
    if (!display || seen.has(display.ratio)) return []
    seen.add(display.ratio)
    return [{ value: display.ratio, label: display.ratio, desc: display.ratioDesc }]
  })
}

export function resolutionOptionsForRatio(sizes: string[], ratio: string) {
  const seen = new Set<string>()
  return sizes
    .flatMap((size) => {
      const display = parseSizeDisplay(size)
      if (!display || display.ratio !== ratio || seen.has(display.resolution)) return []
      seen.add(display.resolution)
      return [{ value: display.resolution, label: display.resolution }]
    })
    .sort((a, b) => Number(a.value.replace('K', '')) - Number(b.value.replace('K', '')))
}

export function resolveSizeForRatio(sizes: string[], ratio: string, currentSize: string): string {
  const currentResolution = selectedResolution(currentSize)
  const candidates = sizes
    .map(size => parseSizeDisplay(size))
    .filter((display): display is SizeDisplay => !!display && display.ratio === ratio)
  return candidates.find(display => display.resolution === currentResolution)?.value || candidates[0]?.value || currentSize
}

export function resolveSizeForResolution(sizes: string[], ratio: string, resolution: string, currentSize: string): string {
  const match = sizes
    .map(size => parseSizeDisplay(size))
    .find(display => display?.ratio === ratio && display.resolution === resolution)
  return match?.value || currentSize
}
