import { readPetEnabled, writePetEnabled } from './nanoPet';

/** "Show Nano avatar" (Settings → Nano account); on by default, remembered in `piui.nano.pet`. */
class NanoPetPreference {
  enabled = $state(readPetEnabled());

  set(enabled: boolean): void {
    this.enabled = enabled;
    writePetEnabled(enabled);
  }
}

export const nanoPetPreference = new NanoPetPreference();
