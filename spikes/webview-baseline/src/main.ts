import { mount } from 'svelte';
import App from './App.svelte';
import './styles.css';

const target = document.getElementById('app');

if (target === null) {
  throw new Error('PiUI baseline could not find its application root.');
}

mount(App, { target });
