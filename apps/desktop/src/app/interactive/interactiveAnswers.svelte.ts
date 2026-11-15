import { interactiveAnswersHost } from '../../host-api/interactiveAnswersClient';

class InteractiveAnswers {
  enabled = $state(true);
  readOnly = $state(false);
  loaded = $state(false);
  error = $state('');
  private loading: Promise<void> | undefined;

  load(): Promise<void> {
    this.loading ??= interactiveAnswersHost.settings().then(settings => {
      this.enabled = settings.enabled;
      this.readOnly = settings.readOnly;
    }).catch((cause: unknown) => {
      this.readOnly = true;
      this.error = cause instanceof Error ? cause.message : 'The setting could not be saved. Nothing was changed.';
    }).finally(() => { this.loaded = true; });
    return this.loading;
  }

  async set(enabled: boolean): Promise<void> {
    if (!this.loaded || this.readOnly) return;
    const previous = this.enabled;
    this.enabled = enabled;
    this.error = '';
    try {
      const settings = await interactiveAnswersHost.update({ enabled });
      this.enabled = settings.enabled;
      this.readOnly = settings.readOnly;
    } catch (cause) {
      this.enabled = previous;
      this.error = cause instanceof Error ? cause.message : 'The setting could not be saved. Nothing was changed.';
    }
  }
}

export const interactiveAnswers = new InteractiveAnswers();
