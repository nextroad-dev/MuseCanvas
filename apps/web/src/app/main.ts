import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'

// Self-hosted fonts keep CSP `font-src 'self' data:` intact and avoid any
// third-party requests. `font-display: swap` ships with the packages, so text
// stays visible if a font file fails to load.
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/noto-sans-sc/400.css'
import '@fontsource/noto-sans-sc/500.css'
import '../assets/index.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)

app.mount('#app')