import type { SiteBrowserAction, SiteBrowserSnapshot, SiteBrowserTab } from '../../../../../contracts/site-browser-v1';

let next = 2;
let tabs: SiteBrowserTab[] = [{ id: 1, url: null, host: null }];
let active = 1;

export function siteBrowserAction(request: SiteBrowserAction): SiteBrowserSnapshot {
  const create = (): void => {
    active = next++;
    tabs.push({ id: active, url: null, host: null });
  };
  switch (request.action) {
    case 'new':
      create();
      break;
    case 'select':
      active = request.tab;
      break;
    case 'close':
      tabs = tabs.filter(({ id }) => id !== request.tab);
      if (tabs.length === 0) create();
      else if (active === request.tab) active = tabs[0]!.id;
      break;
    case 'navigate': {
      const input = request.address.trim();
      const url = new URL(input.includes('://') ? input : `https://${input}`);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid address');
      tabs = tabs.map((tab) => tab.id === request.tab ? { id: tab.id, url: url.href, host: url.hostname } : tab);
      break;
    }
  }
  return { tabs: [...tabs], active };
}
