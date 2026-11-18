/** The part of KaTeX this app uses (the package ships no types of its own). */
declare module 'katex' {
  export interface KatexOptions {
    displayMode?: boolean;
    output?: 'html' | 'mathml' | 'htmlAndMathml';
    throwOnError?: boolean;
    errorColor?: string;
    trust?: boolean;
    strict?: boolean | 'ignore' | 'warn' | 'error';
    maxSize?: number;
    maxExpand?: number;
  }
  const katex: {
    /** Builds the formula as DOM nodes inside `baseNode`, replacing its content. */
    render(expression: string, baseNode: HTMLElement, options?: KatexOptions): void;
  };
  export default katex;
}
