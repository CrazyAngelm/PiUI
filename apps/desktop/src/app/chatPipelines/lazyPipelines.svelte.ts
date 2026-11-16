export type PipelineCode = typeof import('./pipelineCode');

/**
 * The pipeline store, the template helpers and the executor picker load after first paint
 * (first-screen budget, ADR-027). Until they arrive a new chat waits; if they cannot load it talks directly.
 */
export class LazyPipelines {
  code = $state.raw<PipelineCode | undefined>();
  failed = $state(false);
  private pending: Promise<PipelineCode> | undefined;
  private readonly loader: () => Promise<PipelineCode>;

  constructor(loader: () => Promise<PipelineCode> = () => import('./pipelineCode')) {
    this.loader = loader;
  }

  load(): Promise<PipelineCode> {
    if (this.code) return Promise.resolve(this.code);
    this.pending ??= this.loader().then(
      (code) => {
        this.code = code;
        this.failed = false;
        this.pending = undefined;
        return code;
      },
      (error: unknown) => {
        this.failed = true;
        this.pending = undefined;
        throw error;
      },
    );
    return this.pending;
  }
}

export const lazyPipelines = new LazyPipelines();
