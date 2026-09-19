// Inspect UI-owned literal copy; never inspect/translate prompts or native history.
import { parse } from 'svelte/compiler';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { relative, dirname } from 'node:path';
const root = new URL('../src/', import.meta.url);
const files = path => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(new URL(`${entry.name}/`, path)) : entry.name.endsWith('.svelte') ? [new URL(entry.name, path)] : []);
const found = [];
for (const file of files(root)) {
  let source = readFileSync(file, 'utf8');
  const ast = parse(source);
  const edits = [];
  function localized(expression) {
    const original = source.slice(expression.start, expression.end);
    if (expression.type === 'Literal' && typeof expression.value === 'string' && /[A-Za-z]/.test(expression.value)) return `$t(${original})`;
    if (expression.type === 'TemplateLiteral' && expression.quasis.some(part => /[A-Za-z]/.test(part.value.cooked))) {
      const key = expression.quasis.map((part, index) => part.value.cooked + (index < expression.expressions.length ? `{${index}}` : '')).join('');
      return `$t(${JSON.stringify(key)}, [${expression.expressions.map(item => source.slice(item.start, item.end)).join(', ')}])`;
    }
    if (expression.type === 'ConditionalExpression') return `${source.slice(expression.test.start, expression.test.end)} ? ${localized(expression.consequent)} : ${localized(expression.alternate)}`;
    if (expression.type === 'LogicalExpression' && ['||', '??'].includes(expression.operator)) return `${source.slice(expression.left.start, expression.left.end)} ${expression.operator} ${localized(expression.right)}`;
    if (expression.type === 'CallExpression' && expression.callee.name === '$t' && expression.arguments[0]?.type === 'TemplateLiteral') return localized(expression.arguments[0]);
    return original;
  }
  function visit(node, parent, protectedText = false) {
    if (!node || typeof node !== 'object') return;
    protectedText ||= ['pre', 'code', 'script', 'style'].includes(node.name) || ['StyleDirective', 'AttributeShorthand'].includes(node.type);
    if (!protectedText && node.type === 'MustacheTag' && (parent?.type !== 'Attribute' || ['title', 'placeholder', 'aria-label', 'alt'].includes(parent.name))) {
      const text = localized(node.expression);
      if (text !== source.slice(node.expression.start, node.expression.end)) edits.push({ start: node.expression.start, end: node.expression.end, text });
    }
    if (!protectedText && node.type === 'Text' && parent?.type !== 'Attribute' && /[A-Za-z]{2}/.test(node.data) && !/^(PiUI|Pi|Prime Agent|Codex|Hermes|JSON|MCP|OAuth)$/.test(node.data.trim())) {
      found.push({ file: relative(process.cwd(), file.pathname.slice(process.platform === 'win32' ? 1 : 0)), text: node.data.trim() });
      edits.push({ start: node.start, end: node.end, text: node.data.replace(/\S[\s\S]*\S|\S/, value => `{$t(${JSON.stringify(value)})}`) });
    }
    if (node.type === 'Attribute' && ['title', 'placeholder', 'aria-label', 'alt'].includes(node.name) && node.value?.length === 1 && node.value[0].type === 'Text' && /[A-Za-z]/.test(node.value[0].data)) {
      const text = node.value[0].data;
      found.push({ file: file.pathname, text });
      edits.push({ start: node.start, end: node.end, text: `${node.name}={$t(${JSON.stringify(text)})}` });
    }
    for (const [key, value] of Object.entries(node)) {
      if (['instance', 'module', 'css', 'parent'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(child => visit(child, node, protectedText));
      else if (value && typeof value === 'object') visit(value, node, protectedText);
    }
  }
  visit(ast.html);
  if (process.argv.includes('--fix') && edits.length) {
    for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    if (!/import\s*\{[^}]*\bt\b[^}]*\}\s*from[^;]*locale\/language/.test(source)) {
      const path = relative(dirname(file.pathname), new URL('features/locale/language', root).pathname).replaceAll('\\', '/');
      source = source.replace(/<script(?:\s+lang="ts")?>/, value => `${value}\n  import { t } from '${path.startsWith('.') ? path : './' + path}';`);
    }
    writeFileSync(file, source);
  }
}
console.log(JSON.stringify(found, null, 2));
