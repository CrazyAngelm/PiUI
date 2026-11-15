/**
 * Per-device browser storage for the remote shell. Every device is shown by the same page on the
 * same origin, so the desktop shell's own keys (drafts, last route, selected workspace, composer
 * choices) would otherwise be shared between computers: a draft typed for one machine would
 * reappear for another and could be sent to the wrong agent. The remote bundle replaces
 * `localStorage` and `sessionStorage` with views that prefix every key with the device id before
 * any shell module runs, so the desktop code stays as it is and sees an empty store per device.
 *
 * Only the viewer key store (`identity.ts`, IndexedDB) is deliberately shared: it identifies the
 * browser, not a device.
 */

const PREFIX = 'nano-remote:';

export function storageScopePrefix(device: string): string {
  return `${PREFIX}${device}:`;
}

type StorageObject = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem' | 'clear'>;

/** A view of `base` that sees and changes only the keys under `prefix`. */
export function createScopedStorage(base: Storage, prefix: string): Storage {
  const keys = (): string[] => {
    const found: string[] = [];
    for (let index = 0; index < base.length; index += 1) {
      const key = base.key(index);
      if (key !== null && key.startsWith(prefix)) found.push(key.slice(prefix.length));
    }
    return found;
  };
  const view: StorageObject = {
    get length() {
      return keys().length;
    },
    key: (index) => keys()[index] ?? null,
    getItem: (key) => base.getItem(prefix + String(key)),
    setItem: (key, value) => base.setItem(prefix + String(key), String(value)),
    removeItem: (key) => base.removeItem(prefix + String(key)),
    clear: () => {
      for (const key of keys()) base.removeItem(prefix + key);
    },
  };
  return view as Storage;
}

/** A store that lives and dies with the page, for a browser that has no usable storage. */
export function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  const view: StorageObject = {
    get length() {
      return data.size;
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(String(key)) ?? null,
    setItem: (key, value) => void data.set(String(key), String(value)),
    removeItem: (key) => void data.delete(String(key)),
    clear: () => data.clear(),
  };
  return view as Storage;
}

type StorageName = 'localStorage' | 'sessionStorage';

function baseStorage(target: Window, name: StorageName): Storage | undefined {
  try {
    return target[name];
  } catch {
    return undefined;
  }
}

/**
 * Replaces both web storages of `target` with views scoped to `device`. Without a device (an
 * invalid launch address) the shell never mounts, and both become memory stores. Returns false
 * when the browser refuses the replacement, in which case the shell must not mount.
 */
export function installStorageScope(target: Window, device: string | undefined): boolean {
  const names: StorageName[] = ['localStorage', 'sessionStorage'];
  const views = new Map<StorageName, Storage>();
  for (const name of names) {
    const base = baseStorage(target, name);
    views.set(name, device === undefined || base === undefined ? createMemoryStorage() : createScopedStorage(base, storageScopePrefix(device)));
  }
  try {
    for (const [name, view] of views) Object.defineProperty(target, name, { value: view, configurable: true, enumerable: true });
    return names.every((name) => target[name] === views.get(name));
  } catch {
    return false;
  }
}
