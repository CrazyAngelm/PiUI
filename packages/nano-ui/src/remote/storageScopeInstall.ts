import { parseLaunch } from './launch';
import { installStorageScope } from './storageScope';

/**
 * Importing this module scopes the page's web storage to the device in the launch address. It must
 * be the first import of `main.ts`: the desktop shell reads its saved drafts and route while its
 * modules are evaluated, so the scope has to exist before any of them is.
 */
export const storageScoped: boolean = installStorageScope(window, parseLaunch(location.hash)?.device);
