import { mount } from 'svelte';
import { get } from 'svelte/store';
import App from './app/DesktopRoot.svelte';
import { language, loadRussian } from './features/locale/language';
import './styles/reset.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/motion.css';

const target = document.getElementById('app');

if (target === null) {
  throw new Error('PiUI could not find the application root.');
}

// Russian copy is a separate chunk; load it first so the first paint is already
// translated. English never waits, and a failed load falls back to English.
if (get(language) === 'ru') {
  void loadRussian()
    .catch(() => undefined)
    .then(() => mount(App, { target }));
} else {
  mount(App, { target });
}
