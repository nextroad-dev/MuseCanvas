/**
 * 深色模式防闪烁脚本。
 *
 * 必须是「阻塞式内联脚本」，且排在 `<head>` 里样式表之后：在首次绘制前就给
 * `<html>` 打上 `dark`（并同步 `color-scheme`），否则首帧会先按浅色画一遍再切深色。
 *
 * 解析规则必须与 `ui/theme-toggle.tsx` 完全一致：
 * · 存储键 `musecanvas-theme`，取值 `light | dark | system`（缺失/非法 = `system`）；
 * · `system` 跟随 `prefers-color-scheme`；
 * · 结果同时落到 `<html class="dark">`（CSS token 选择器）与 `data-theme`
 *   （供 QA / e2e 读取当前生效主题）。
 *
 * 保持极短：内联脚本会在每个 HTML 响应里重复，且必须不依赖任何外部资源。
 */
const THEME_SCRIPT = `(function(){try{var s=null;try{s=localStorage.getItem('musecanvas-theme')}catch(e){}var m=s==='light'||s==='dark'?s:(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');var r=document.documentElement;if(m==='dark'){r.classList.add('dark')}else{r.classList.remove('dark')}r.dataset.theme=m;r.style.colorScheme=m}catch(e){}})()`

export function ThemeBootScript() {
  return <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
}
