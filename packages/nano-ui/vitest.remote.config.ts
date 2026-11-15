import { defineConfig } from 'vitest/config';

// Unit tests of the remote transport, connection and pairing crypto. They run in Node,
// whose global WebCrypto is the API the browser code uses; sockets are scripted fakes.
export default defineConfig({
  test: { environment: 'node', include: ['src/remote/**/*.test.ts'] },
});
