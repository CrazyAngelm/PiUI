import { mount } from 'svelte';
import App from './app/App.svelte';
import './styles/reset.css';
import './styles/tokens.css';
import './styles/app.css';

const target = document.getElementById('app');

if (target === null) {
  throw new Error('PiUI could not find the application root.');
}

mount(App, { target });
