import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ClassicViewEntry from './settings/ClassicViewEntry.svelte';
import { viewUrl } from './viewSwitch';

describe('switching to and from the classic views', () => {
  it('sets or removes only the view parameter', () => {
    expect(viewUrl('http://127.0.0.1:1420/?lab=demo', 'legacy')).toBe('http://127.0.0.1:1420/?lab=demo&view=legacy');
    expect(viewUrl('http://127.0.0.1:1420/?view=legacy&lab=safe', 'classic')).toBe('http://127.0.0.1:1420/?view=classic&lab=safe');
    expect(viewUrl('http://127.0.0.1:1420/?view=classic&lab=safe', undefined)).toBe('http://127.0.0.1:1420/?lab=safe');
    expect(viewUrl('tauri://localhost/', 'legacy')).toBe('tauri://localhost/?view=legacy');
  });

  it('announces the removal in the next release next to both entries', () => {
    const { body } = render(ClassicViewEntry, { props: { onOpen: () => {} } });
    expect(body).toContain('will be removed in the next one');
    expect(body).toContain('Open classic view');
    expect(body).toContain('Open Pi-only view');
  });
});
