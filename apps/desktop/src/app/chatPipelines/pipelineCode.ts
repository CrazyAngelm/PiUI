/** Everything the new-chat composer needs for pipelines, as one chunk outside the first-paint bundle. Import it only through `lazyPipelines`. */
export { default as ExecutorPicker } from './ExecutorPicker.svelte';
export { chatPipelines } from './chatPipelines.svelte';
export * as templateRun from './templateRun';
