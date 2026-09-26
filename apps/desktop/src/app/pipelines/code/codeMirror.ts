/**
 * CodeMirror 6 for script steps: highlighting for Node.js, Python and
 * PowerShell, line numbers, bracket matching, history and indentation.
 *
 * Only `ScriptEditor.svelte` imports this module, and only dynamically, so
 * it never reaches the main bundle; each language loads on first use.
 *
 * Content Security Policy: the desktop app allows `style-src 'self'` only.
 * CodeMirror injects its styles through style-mod, which writes a `<style>`
 * element into a document (refused by that policy) but uses constructable
 * stylesheets (`adoptedStyleSheets`, CSSOM) in a shadow root. The editor is
 * therefore always mounted in its own shadow root. It sets element styles
 * only through CSSOM and never uses `eval`/`new Function`.
 */
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderText,
} from '@codemirror/view';
import { bracketMatching, HighlightStyle, indentOnInput, indentUnit, LanguageSupport, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { tags } from '@lezer/highlight';
import type { ScriptRuntime } from '../../../host-api/orchestrationClient';

export type CodeEditorSize = 'editor' | 'viewer';

export interface CodeEditorOptions {
  readonly value: string;
  readonly runtime: ScriptRuntime;
  /** Accessible name of the text box. */
  readonly label: string;
  /** Read-only content stays focusable and selectable. */
  readonly readOnly: boolean;
  readonly size: CodeEditorSize;
  /** Accessible description, e.g. how to leave the editor with the keyboard. */
  readonly description?: string;
  readonly placeholder?: string;
  readonly onChange?: (value: string) => void;
  readonly onBlur?: () => void;
}

export interface CodeEditorHandle {
  /** Replaces the text when it differs, without reporting it as an edit. */
  setValue(value: string): void;
  setRuntime(runtime: ScriptRuntime): Promise<void>;
  setReadOnly(readOnly: boolean): void;
  focus(): void;
  destroy(): void;
}

/** Indentation per language: two spaces for JavaScript, four otherwise. */
export const INDENT: Readonly<Record<ScriptRuntime, string>> = { node: '  ', python: '    ', powershell: '    ' };

/** The syntax of `runtime`, loaded on first use. */
export async function languageFor(runtime: ScriptRuntime): Promise<Extension> {
  switch (runtime) {
    case 'node': {
      const { javascriptLanguage } = await import('@codemirror/lang-javascript');
      return [new LanguageSupport(javascriptLanguage), indentUnit.of(INDENT.node)];
    }
    case 'python': {
      const { pythonLanguage } = await import('@codemirror/lang-python');
      return [new LanguageSupport(pythonLanguage), indentUnit.of(INDENT.python)];
    }
    case 'powershell': {
      const { powerShell } = await import('@codemirror/legacy-modes/mode/powershell');
      return [StreamLanguage.define(powerShell), indentUnit.of(INDENT.powershell)];
    }
    default: {
      const exhaustive: never = runtime;
      return exhaustive;
    }
  }
}

/** Token colors from the design tokens, so light and dark follow the theme. */
export const codeHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.modifier], color: 'var(--piui-syntax-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character, tags.escape], color: 'var(--piui-syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--piui-syntax-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: 'var(--piui-syntax-comment)', fontStyle: 'italic' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.function(tags.definition(tags.variableName)), tags.standard(tags.variableName)],
    color: 'var(--piui-syntax-function)',
  },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.self, tags.special(tags.variableName)], color: 'var(--piui-syntax-type)' },
  { tag: [tags.propertyName, tags.attributeName, tags.labelName], color: 'var(--piui-syntax-property)' },
  { tag: [tags.operator, tags.punctuation, tags.bracket, tags.separator, tags.derefOperator], color: 'var(--piui-syntax-punctuation)' },
  { tag: tags.invalid, color: 'var(--piui-danger)' },
]);

const selection = 'color-mix(in srgb, var(--piui-accent) 30%, transparent)';

/** Surface, gutter, focus and selection from the design tokens. */
export const codeTheme = EditorView.theme({
  '&': {
    border: '1px solid var(--piui-border)',
    borderRadius: 'var(--piui-radius-sm)',
    backgroundColor: 'var(--piui-code-surface)',
    color: 'var(--piui-text)',
    fontSize: '12px',
  },
  '&:hover': { borderColor: 'var(--piui-border-strong)' },
  '&.cm-focused': {
    outline: 'none',
    borderColor: 'var(--piui-focus)',
    boxShadow: '0 0 0 3px color-mix(in srgb, var(--piui-focus) 18%, transparent)',
  },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--piui-font-mono)', lineHeight: '1.5' },
  '.cm-content': { padding: '6px 0', caretColor: 'var(--piui-text)' },
  '.cm-line': { padding: '0 10px 0 6px' },
  '.cm-gutters': {
    borderRight: '1px solid var(--piui-border-subtle)',
    borderTopLeftRadius: 'var(--piui-radius-sm)',
    borderBottomLeftRadius: 'var(--piui-radius-sm)',
    backgroundColor: 'var(--piui-code-surface)',
    color: 'var(--piui-syntax-comment)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--piui-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--piui-hover)', color: 'var(--piui-text-muted)' },
  '.cm-content ::selection, .cm-line::selection, .cm-line ::selection': { backgroundColor: selection },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--piui-success) 22%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--piui-success) 60%, transparent)',
  },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--piui-danger-surface)', color: 'var(--piui-danger-text)' },
  '.cm-placeholder': { color: 'var(--piui-text-disabled)' },
});

/** The inspector's editor grows from about 10 to 28 lines; the run view shows up to 24. */
const SIZE: Readonly<Record<CodeEditorSize, Extension>> = {
  editor: EditorView.theme({ '&': { maxHeight: '520px' }, '.cm-content, .cm-gutter': { minHeight: '190px' } }),
  viewer: EditorView.theme({ '&': { maxHeight: '440px' } }),
};

/** Marks text set from outside, which is not reported back as an edit. */
const external = Annotation.define<boolean>();

function accessExtensions(readOnly: boolean): Extension {
  return readOnly
    ? [EditorState.readOnly.of(true), EditorView.contentAttributes.of({ 'aria-readonly': 'true' }), keymap.of([...defaultKeymap])]
    : // Tab indents; Escape, then Tab moves focus out (CodeMirror's tab focus mode).
      keymap.of([indentWithTab, ...historyKeymap, ...defaultKeymap]);
}

/**
 * Mounts an editor in `host`'s own shadow root (see the module comment) and
 * returns its handle. Throws when the browser cannot provide one, so the
 * caller can keep its plain text field.
 */
export async function mountCodeEditor(host: HTMLElement, options: CodeEditorOptions): Promise<CodeEditorHandle> {
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  if (!('adoptedStyleSheets' in root)) throw new Error('Constructable stylesheets are unavailable.');
  const language = new Compartment();
  const access = new Compartment();
  const initialLanguage = await languageFor(options.runtime);
  root.replaceChildren();
  const describedBy: Record<string, string> = {};
  if (options.description) {
    // IDs resolve inside this shadow root; a hidden node still describes.
    const hint = document.createElement('p');
    hint.id = 'piui-code-description';
    hint.hidden = true;
    hint.textContent = options.description;
    root.append(hint);
    describedBy['aria-describedby'] = hint.id;
  }
  let languageRequest = 0;
  const view = new EditorView({
    root,
    parent: root,
    state: EditorState.create({
      doc: options.value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        indentOnInput(),
        bracketMatching(),
        EditorState.tabSize.of(4),
        syntaxHighlighting(codeHighlight),
        codeTheme,
        SIZE[options.size],
        language.of(initialLanguage),
        access.of(accessExtensions(options.readOnly)),
        EditorView.contentAttributes.of({ 'aria-label': options.label, ...describedBy }),
        ...(options.placeholder ? [placeholderText(options.placeholder)] : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(external))) {
            options.onChange?.(update.state.doc.toString());
          }
          if (update.focusChanged && !update.view.hasFocus) options.onBlur?.();
        }),
      ],
    }),
  });
  return {
    setValue(value) {
      const current = view.state.doc.toString();
      if (value === current) return;
      view.dispatch({ changes: { from: 0, to: current.length, insert: value }, annotations: external.of(true) });
    },
    async setRuntime(runtime) {
      const request = (languageRequest += 1);
      const next = await languageFor(runtime);
      if (request === languageRequest) view.dispatch({ effects: language.reconfigure(next) });
    },
    setReadOnly(readOnly) {
      view.dispatch({ effects: access.reconfigure(accessExtensions(readOnly)) });
    },
    focus() {
      view.focus();
    },
    destroy() {
      view.destroy();
      root.replaceChildren();
    },
  };
}
