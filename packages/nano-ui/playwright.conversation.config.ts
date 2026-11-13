import { defineConfig } from '@playwright/test';
import graph from './playwright.config';

// Keep the same resource policy and reused browser profile as the graph proof.
const port = Number(process.env.NANO_CONVERSATION_TEST_PORT);
if (!Number.isSafeInteger(port) || port <= 0) throw new Error('Set NANO_CONVERSATION_TEST_PORT to an available local proof port.');
if (!process.env.NANO_CONVERSATION_TEST_OUTPUT) throw new Error('Set NANO_CONVERSATION_TEST_OUTPUT to the task scratch directory.');
export default defineConfig({
  ...graph,
  testMatch: 'conversation.spec.ts',
  outputDir: process.env.NANO_CONVERSATION_TEST_OUTPUT,
  use: { ...graph.use, baseURL: `http://127.0.0.1:${port}` },
  projects: [{ name: 'shared-conversation' }],
  webServer: { command: `node tests/conversation-static-server.mjs ${port}`, url: `http://127.0.0.1:${port}/tests/conversation-host.html`, reuseExistingServer: false },
});
