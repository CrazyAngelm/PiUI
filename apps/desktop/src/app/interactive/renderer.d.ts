export interface IntelligentUiHost {
  send?: (text: string, payload: string | null) => Promise<boolean>;
  copy?: (text: string) => Promise<boolean>;
  label?: (key: string, args?: readonly string[]) => string;
}

export interface IntelligentUiScope {
  enhance(root: HTMLElement, host: IntelligentUiHost): void;
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
export const unsupportedNodeTypes: readonly ['image', 'gallery', 'video', 'audio', 'region', 'html'];
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
