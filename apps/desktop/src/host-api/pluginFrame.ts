/**
 * The plugin protocol's response rules (`crates/piui-plugins/src/csp.rs`),
 * mirrored for the UI Lab's development server and the E2E tests that
 * serve example plugin panels the way the desktop host does. The golden
 * fixture `contracts/fixtures/plugin-panel-csp.json` keeps both equal.
 */

export const PLUGIN_SCHEME = 'piui-plugin';
/** The Windows (WebView2) form of the plugin origin; elsewhere `piui-plugin://localhost`. */
export const PLUGIN_ORIGIN_WINDOWS = 'http://piui-plugin.localhost';

/** The URL path of a plugin's UI folder, ending in `/` (`example.hello/ui/`). */
export function uiBase(id: string, uiEntry: string): string {
  const slash = uiEntry.lastIndexOf('/');
  return slash < 0 ? `${id}/` : `${id}/${uiEntry.slice(0, slash)}/`;
}

/** The policy of one plugin's panel documents on `origin`. */
export function panelPolicy(origin: string, base: string): string {
  const own = `${origin}/${base}`;
  return `default-src 'none'; script-src ${own}; style-src ${own}; img-src ${own} data:; font-src ${own}; `
    + `connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; `
    + `manifest-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`;
}

const TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
};

/** The content type of a served file; anything else is not served. */
export function contentType(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? undefined : TYPES[path.slice(dot + 1).toLowerCase()];
}

/** Response headers the host sends for `path` of a panel whose UI folder is `base`. */
export function panelHeaders(origin: string, base: string, path: string): Record<string, string> | undefined {
  const type = contentType(path);
  if (type === undefined) return undefined;
  const common = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  return path.toLowerCase().endsWith('.html')
    ? { ...common, 'Content-Security-Policy': panelPolicy(origin, base) }
    : { ...common, 'Access-Control-Allow-Origin': '*' };
}
