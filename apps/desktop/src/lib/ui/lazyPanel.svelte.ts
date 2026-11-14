/** A closed picker never requests its panel. Successful loads are reused; failures can be retried. */
export class LazyPanel<T> {
  component = $state.raw<T | undefined>();
  failed = $state(false);
  private pending: Promise<void> | undefined;

  constructor(private readonly importPanel: () => Promise<{ default: T }>) {}

  load(): Promise<void> {
    if (this.component) return Promise.resolve();
    if (this.pending) return this.pending;
    this.failed = false;
    this.pending = this.importPanel()
      .then((module) => { this.component = module.default; })
      .catch(() => { this.failed = true; })
      .finally(() => { this.pending = undefined; });
    return this.pending;
  }
}
