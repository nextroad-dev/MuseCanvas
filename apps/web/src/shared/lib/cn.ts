import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * 合并条件类名，后者覆盖前者的同类工具类（`px-2` + `px-4` → `px-4`）。
 *
 * 所有原语都通过 `cn()` 暴露 `className` 逃生口，调用方只覆盖单个属性、
 * 不必重写整条样式。下面把设计 token 生成的工具类注册进 tailwind-merge 的
 * 真实分组：否则 `text-title`（字号）会被当成颜色，`cn('text-title',
 * 'text-foreground')` 会悄悄删掉字号；`shadow-soft`（阴影）同理。新增
 * `--text-*` / `--z-index-*` / `--shadow-*` / `--radius-*` / `--container-*`
 * token 时，必须同步补到这里。
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      // --text-* 字号阶梯（行高 / 字距 / 字重随 token 一起输出）
      'font-size': [
        'text-display',
        'text-hero',
        'text-headline',
        'text-cta',
        'text-title',
        'text-section',
        'text-statement',
        'text-subtitle',
        'text-lead',
        'text-copy',
        'text-module',
        'text-compact',
        'text-ui',
        'text-overline',
        'text-caption',
      ],
      // --z-index-* 层级阶梯
      z: ['z-sticky', 'z-dropdown', 'z-overlay', 'z-modal', 'z-toast', 'z-tooltip', 'z-command'],
      // --shadow-* 高度阶梯
      shadow: [
        'shadow-soft',
        'shadow-floating',
        'shadow-dropdown',
        'shadow-toast',
        'shadow-modal',
        'shadow-drawer',
        'shadow-command',
      ],
      // --radius-* 语义圆角
      rounded: [
        'rounded-checkbox',
        'rounded-control',
        'rounded-popover',
        'rounded-card',
        'rounded-panel',
        'rounded-pill',
      ],
      // --container-* 内容宽度，`max-w-*` 形态
      'max-w': [
        'max-w-content',
        'max-w-form',
        'max-w-reading',
        'max-w-sidebar',
        'max-w-sidebar-collapsed',
        'max-w-settings-nav',
        'max-w-dialog-narrow',
        'max-w-dialog-wide',
      ],
      // 固定侧栏是宽度不是上限，单独成组，后者按意图覆盖而不是靠 CSS 顺序
      w: ['w-sidebar', 'w-sidebar-collapsed', 'w-settings-nav'],
      'min-h': ['min-h-header'],
      h: ['h-header'],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
