import { mount } from 'svelte';
import { get } from 'svelte/store';
import SiteBrowser from './app/browser/SiteBrowser.svelte';
import { language, loadRussian } from './features/locale/language';
import { stylePreference } from './styles/stylePreference.svelte';
import './styles/reset.css';
import './styles/tokens.css';
import './styles/app.css';

async function start(): Promise<void> {
  stylePreference.apply();
  if (get(language) === 'ru') await loadRussian().catch(() => undefined);
  const target = document.getElementById('app');
  if (target !== null) mount(SiteBrowser, { target });
}

void start();
