/**
 * Presentation of step executors (orchestration v6.2) in the editor and the
 * run view. Rules live in `host-api/stepExecutors.ts`; the host is the authority.
 */
import type { ScriptRuntime } from '../../host-api/orchestrationClient';

export const RUNTIME_LABEL: Readonly<Record<ScriptRuntime, string>> = {
  node: 'Node.js',
  python: 'Python',
  powershell: 'PowerShell',
};

/** Starter code: read the stdin document, print one JSON object (or plain text). */
export const SCRIPT_EXAMPLES: Readonly<Record<ScriptRuntime, string>> = {
  node: `let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const { inputs, dependencies } = JSON.parse(raw);

// dependencies[<step id>] is { text, data } from each step this one depends on.
const summary = Object.values(dependencies).map((item) => item.text ?? '').join('\\n');

console.log(JSON.stringify({ summary }));
`,
  python: `import json
import sys

document = json.load(sys.stdin)
inputs = document["inputs"]
dependencies = document["dependencies"]

# dependencies[<step id>] is {"text": ..., "data": ...} from each step this one depends on.
summary = "\\n".join((item["text"] or "") for item in dependencies.values())

print(json.dumps({"summary": summary}))
`,
  powershell: `$document = [Console]::In.ReadToEnd() | ConvertFrom-Json
$inputs = $document.inputs

# $document.dependencies.<step id> has .text and .data from each step this one depends on.
$summary = ($document.dependencies.PSObject.Properties | ForEach-Object { $_.Value.text }) -join "\`n"

@{ summary = $summary } | ConvertTo-Json -Compress
`,
};

/** First meaningful line of a script, for node cards. */
export function firstCodeLine(source: string): string {
  return (
    source
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line !== '' && !/^(#|\/\/)/u.test(line)) ?? ''
  );
}

const encoder = new TextEncoder();

export function sourceBytes(source: string): number {
  return encoder.encode(source).length;
}
