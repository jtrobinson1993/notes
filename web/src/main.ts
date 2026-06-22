import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { PiniaColada } from '@pinia/colada';
import App from './App.vue';
import { router } from './router';
import { initTheme } from './lib/theme';
import { trackViewportHeight } from './lib/viewport';
import './style.css';

initTheme();
trackViewportHeight();

const app = createApp(App);
app.use(createPinia());
app.use(PiniaColada, {});
app.use(router);
app.mount('#app');
