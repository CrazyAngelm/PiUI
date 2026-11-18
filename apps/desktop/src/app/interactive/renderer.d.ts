/** Operations only trusted application code supplies; the answer's JSON supplies content, never behaviour. */
export interface IntelligentUiHost {
  /** Posts a reply to the chat. Always present where the answer may be shown; `sendBlock` says when it cannot be used. */
  send?: (text: string, payload: string | null) => Promise<boolean>;
  /** Why a reply cannot be posted right now (read live: agent answering, chat closed, no prompt...). Nothing while it can. */
  sendBlock?: () => string | null | undefined;
  copy?: (text: string) => Promise<boolean>;
  label?: (key: string, args?: readonly string[]) => string;
  /** Opens an absolute https address through the host. Without it a link copies its address. */
  openLink?: (url: string) => Promise<boolean>;
  /** Runs one action of the closed `appActionTargets` list; true when it was done. */
  app?: (target: string) => Promise<boolean>;
  /**
   * Resolves the name of a file of this chat (a file name or a path relative to the project) to a
   * `blob:` URL the host made from the file's bytes. `null` means the file is not there yet (the place
   * waits and asks again); a rejection means it can never be shown.
   */
  resolveFile?: (name: string) => Promise<string | null>;
  /** A place stopped showing the URL `resolveFile(name)` gave it (scrolled far away, collapsed); the host may free it. */
  releaseFile?: (name: string) => void;
  /** Typesets TeX into the element (the element already shows the source as text). */
  renderFormula?: (element: HTMLElement, tex: string, display: boolean) => void;
  /** Short status text for the person (a copied or failed link). */
  notify?: (message: string) => void;
}

export interface IntelligentUiScope {
  enhance(root: HTMLElement, host: IntelligentUiHost): void;
  /** Re-evaluates bound values after the host's own state changed. */
  refresh(): void;
  /** Marks every mounted interface for a rebuild by the next `enhance` (state is kept). */
  rebuild(): void;
  dispose(): void;
}

export type IntelligentUiJson = string | number | boolean | null | IntelligentUiJson[] | { [key: string]: IntelligentUiJson };
export interface ParsedIntelligentUiSpec { value: IntelligentUiJson; closed: boolean }
export interface IntelligentUiExpressionScope { get(name: string): unknown }
export interface IntelligentUiChartData {
  labels: string[];
  series: { name: string; values: (number | { x: number; y: number })[]; color: number }[];
  format: unknown;
  digits: unknown;
  stacked: boolean;
}

export const intelligentUiLanguage: 'hermes-ui';
export const intelligentUiCodeSelector: string;
export const nodeTypes: readonly string[];
/** Node types that show a note instead of running (custom HTML and canvas, ADR-077). */
export const unsupportedNodeTypes: readonly ['html', 'canvas'];
/** The closed list of application actions a button may request. */
export const appActionTargets: readonly ['open_settings', 'new_chat', 'open_schedule', 'open_agents'];
export function createIntelligentUiScope(): IntelligentUiScope;
export function enhanceIntelligentUi(root: HTMLElement, host: IntelligentUiHost): void;
export function setIntelligentUiLocale(locale: string): void;
export function parseSpec(source: string): ParsedIntelligentUiSpec;
export function parsePartialJson(text: string): ParsedIntelligentUiSpec;
export function resolveValue(value: unknown, scope: IntelligentUiExpressionScope): unknown;
export function interpolate(template: string, scope: IntelligentUiExpressionScope): string;
export function evaluate(expression: string, scope: IntelligentUiExpressionScope): unknown;
export function toNumber(value: unknown): number;
export function formatValue(value: unknown, format?: string, digits?: number): string;
export function normalizeChartData(node: Readonly<Record<string, unknown>>, scope: IntelligentUiExpressionScope, host?: IntelligentUiHost): IntelligentUiChartData;
export function niceTicks(min: number, max: number, count?: number): number[];
