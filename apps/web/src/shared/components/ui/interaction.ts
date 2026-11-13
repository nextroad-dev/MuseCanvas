/**
 * `ui/` 下所有控件共享的交互态类。
 *
 * 约定：颜色变化用 `transition-colors`（globals.css 已把默认时长/缓动指向 token）；
 * 可按压控件只用 `.motion-press`（它同时负责颜色与 0.98 下压，不要再叠加
 * `transition-*`）；hover 用 `not-disabled:` 以便同时匹配 `<button>` 与 `<a>`；
 * 焦点环由 globals.css 的全局 `:focus-visible` 负责，焦点真实落在视觉隐藏的
 * `peer` 输入上时（checkbox / radio）用 `focusRingPeer` 把同一个环转移到可见形状。
 */

/** 非按压控件的颜色过渡。 */
export const colourTransition = 'transition-colors'

/** 唯一的按压语义（缩放 + 颜色，时长走 token）。 */
export const motionPress = 'motion-press'

/** 需要显式键盘焦点环的控件（覆盖全局 outline 时使用）。 */
export const focusRing =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus'

/** 从视觉隐藏的 `peer` 输入转移到可见兄弟节点的焦点环。 */
export const focusRingPeer =
  'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-border-focus'

/** 描边控件（Input / Select / Switch 关闭态）hover 时加深描边。 */
export const outlineHover = 'not-disabled:hover:border-border-strong'

/** 同上，但 hover 发生在包裹的 `group` label 或 `peer` 输入上。 */
export const peerOutlineHover = 'group-hover:border-border-strong peer-hover:border-border-strong'

/** 仅颜色变化的行 hover（表格、列表行），按需开启。 */
export const rowHover = 'transition-colors hover:bg-surface-hover'

/** 可按压表面（同时带颜色过渡）。 */
export const pressable = `${motionPress} ${colourTransition}`
