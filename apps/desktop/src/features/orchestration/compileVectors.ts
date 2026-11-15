/**
 * Generates `contracts/fixtures/unified-shell/graph/compile-vectors-v1.json`
 * (ADR-059): the editor's import path for real system documents, so that the
 * Rust compiler (`crates/piui-orchestration/src/compile.rs`) and the server
 * can be compared with it. Test-only: nothing here runs in the application.
 *
 * Each definition comes from `parseSystemFile` -> `systemFileToGraph` ->
 * `graphIssues` -> `compileGraph`, the editor's import and save path. Only
 * the identifiers that path generates at random are renamed, one to one
 * (`normalize`). Server outcomes are predictions read from the server source
 * and stay labelled `predicted` until a C# test confirms them.
 */
import { readFileSync } from 'node:fs';
import validateV5 from '../../../../../contracts/system-file-v5-validator.mjs';
import type { RunDefinitionSnapshot } from '../../../../../contracts/orchestration-v6';
import {
  GRAPH_COMPILE_DOCUMENT_VERSION_V2, GRAPH_COMPILE_REFUSALS_V2,
  type GraphCompileIdentityV2, type GraphCompileRefusalV2, type GraphPipelineNameV2,
} from '../../../../../contracts/nano-graph-kernel-v2';
import { compileGraph, graphIssues, type AgentGraph } from './agentGraph';
import { parseSystemFile, serializeSystemFile, systemFileToGraph, type SystemFile } from './systemFile';

/** The vector file, relative to this directory (and to its test). */
export const COMPILE_VECTORS_FILE = '../../../../../contracts/fixtures/unified-shell/graph/compile-vectors-v1.json';

/** Host identity of every vector. No agent of the corpus uses these ids. */
export const VECTOR_IDENTITY = { teamId: 'vector-team', pipelineId: 'vector-pipeline', launchCommandId: 'vector-command' } as const satisfies GraphCompileIdentityV2;

/** `HermesGraphAdmission.Compile(source, draftId)` uses the draft id as team and pipeline id and emits no launch command. */
export const SERVER_DRAFT_ID = '5f2b7c1e-8a43-4d6b-9e0f-1c2d3e4f5a6b';

const parseJson = (text: string) => JSON.parse(text);
/** A parsed, deliberately untyped document that a case edits. */
type Json = ReturnType<typeof parseJson>;

const repository = (path: string): string => readFileSync(new URL(`../../../../../${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const example = (name: string): string => repository(`examples/systems/${name}`);
const sharedEdgeCase = (key: string): Json => parseJson(repository('contracts/fixtures/shared-graph-edge-cases-v1.json'))[key];

/** Replaces exactly one occurrence, so a spelling case cannot silently miss. */
function spell(text: string, from: string, to: string): string {
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + 1) >= 0) throw new Error(`Spelling ${from} must occur exactly once.`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

/** The server's cloud profile: Hermes, native permissions, a Nano mode, nothing else it refuses. */
function cloudProfile(profile: Json, model = 'auto'): void {
  profile.harness = 'hermes';
  profile.permissionMode = 'native';
  profile.model = model;
  for (const key of ['modelProvider', 'reasoning', 'serviceTier', 'baseInstructions', 'networkAccess', 'resourceRules']) delete profile[key];
  profile.toolPolicy = { rules: [] };
}

const project: readonly GraphPipelineNameV2[] = [{ id: 'cmd-testing', name: 'Testing' }, { id: 'cmd-release', name: 'Release check' }];

type Expected =
  | { readonly outcome: 'compiled' }
  | { readonly outcome: 'refused'; readonly refusal: GraphCompileRefusalV2; readonly rule: string };

/** What the editor does with a case; the generator fails when it does something else. */
type Editor = 'saved' | 'importRefused' | 'saveRefused';

interface CompileCase {
  readonly id: string;
  readonly purpose: string;
  readonly source: string;
  /** The exact document text. */
  readonly text: () => string;
  readonly pipelines?: readonly GraphPipelineNameV2[];
  readonly editor: Editor;
  readonly rust: Expected;
  /** Required whenever the editor and the compiler disagree. */
  readonly difference?: string;
  /** Server facts a source reading cannot derive mechanically. */
  readonly serverNote?: string;
  /** Replaces the mechanical Compile prediction when the outcome depends on System.Text.Json behaviour the source does not show. */
  readonly serverCompile?: { readonly outcome: 'uncertain'; readonly expected: string };
  /** Replaces the default kernel prediction (`created`) when protocol 1 refuses the definition or cannot decode the create frame. */
  readonly serverKernel?: KernelPrediction;
  /** Replaces the draft save prediction (Ajv) where .NET regular expressions read the schema differently. */
  readonly serverDraft?: 'accepted' | 'refused';
  /** Leave the definitions out of the file (size and nesting); only when the compiler refuses. */
  readonly omitDefinition?: string;
}

/**
 * The version 5 text of an example: the example itself, or for versions 1-4
 * the editor's export of it (the text a version 5 consumer receives).
 */
function v5Text(name: string): string {
  const text = example(name);
  return parseJson(text).version === GRAPH_COMPILE_DOCUMENT_VERSION_V2 ? text : serializeSystemFile(systemFileToGraph(parseSystemFile(text)));
}

function derived(name: string, change: (file: Json) => void, layout: 'indented' | 'compact' = 'indented'): () => string {
  return () => {
    const file = parseJson(v5Text(name));
    change(file);
    return `${layout === 'compact' ? JSON.stringify(file) : JSON.stringify(file, null, 2)}\n`;
  };
}

const refused = (refusal: GraphCompileRefusalV2, rule: string): Expected => ({ outcome: 'refused', refusal, rule });
const compiled: Expected = { outcome: 'compiled' };

const shipped = (name: string, purpose: string, pipelines?: readonly GraphPipelineNameV2[]): CompileCase => ({
  id: `example-${name.replace('.piui.json', '')}`, purpose, source: `examples/systems/${name}`, text: () => example(name),
  ...(pipelines ? { pipelines } : {}), editor: 'saved', rust: compiled,
});

/** The routed-review example on the server's cloud profile (program router profiles only name the step). */
function cloudRouted(file: Json): void {
  cloudProfile(file.agents[0].profile);
  cloudProfile(file.agents[2].profile);
}

function nestedNot(depth: number): Json {
  let predicate: Json = { op: 'equals', field: 'status', value: 'ready' };
  for (let level = 0; level < depth; level++) predicate = { op: 'not', predicate };
  return predicate;
}

/** The server's test document (HermesGraphExecutionTests.Document), compact as the C# test writes it. */
function serverProof(change: (file: Json) => void = () => {}): string {
  const file: Json = { format: 'piui-system', version: 5, name: 'Cloud proof', agents: [
    { id: 'a', task: 'First task', profile: { name: 'First', harness: 'hermes', model: 'auto', permissionMode: 'native', instructions: '', toolPolicy: { rules: [] } }, resultFields: [{ name: 'approved', kind: 'boolean' }] },
    { id: 'b', task: 'Second task', profile: { name: 'Second', harness: 'hermes', model: 'auto', permissionMode: 'native', instructions: '', toolPolicy: { rules: [] } }, inputBindings: [{ sourceStepId: 'a', field: 'approved', name: 'verdict' }] },
  ], connections: [{ from: 'a', to: 'b', kind: 'result' }] };
  change(file);
  return `${JSON.stringify(file)}\n`;
}

export const COMPILE_CASES: readonly CompileCase[] = [
  shipped('single.piui.json', 'Version 1: one agent, upgraded to version 5 by the editor.'),
  shipped('parallel-synthesis.piui.json', 'Version 1: two result dependencies into one step.'),
  shipped('mixed-review.piui.json', 'Version 2: a Codex result into a Prime Agent step with a task input.'),
  shipped('codex-hermes-review.piui.json', 'Version 3: a Codex result into a Hermes step.'),
  shipped('agent-script-llm.piui.json', 'Version 4: a host script without a team member and a single model call with input bindings.'),
  shipped('codex-claude-pi-review.piui.json', 'Version 4: Claude Code reasoning and Pi in one pipeline.'),
  shipped('codex-gemini-acp-review.piui.json', 'Version 4: an ACP agent identity with native permissions.'),
  shipped('routed-review.piui.json', 'Version 4: a program router that needs approval and a route gate.'),
  shipped('structured-review.piui.json', 'Version 4: run inputs, input bindings, a bounded review and approval.'),
  shipped('codex-nano-pi-review.piui.json', 'Version 5: a Nano profile and a Pi tool rule.'),
  shipped('development-with-testing.piui.json', 'Version 5: a sub-pipeline resolved by name, run inputs, outputs and a model call.', project),
  shipped('testing.piui.json', 'Version 5: declared outputs that read result fields.'),
  {
    id: 'edge-nested-not-65', purpose: 'Shared edge case: 65 nested `not` predicates are read without an invented depth limit.',
    source: 'contracts/fixtures/shared-graph-edge-cases-v1.json#nestedNot65', text: () => `${JSON.stringify(sharedEdgeCase('nestedNot65'))}\n`,
    editor: 'saved', rust: compiled,
  },
  {
    id: 'edge-escaped-nul-name', purpose: 'Shared edge case (version 4): an escaped NUL in the name is kept as text.',
    source: 'contracts/fixtures/shared-graph-edge-cases-v1.json#escapedNulName', text: () => `${JSON.stringify(sharedEdgeCase('escapedNulName'))}\n`,
    editor: 'saved', rust: compiled,
  },
  {
    id: 'collaboration', purpose: 'Message, observation and delegation edges, including delegation to itself, an explicit agent executor and spawned agents joining the team.',
    source: 'derived from examples/systems/mixed-review.piui.json',
    text: derived('mixed-review.piui.json', (file) => {
      Object.assign(file.agents[1].profile, { harness: 'codex', permissionMode: 'read-only', serviceTier: 'standard' });
      file.agents[0].executor = { type: 'agent' };
      file.inheritTeamConnections = true;
      file.connections.push(
        { from: 'research', to: 'review', kind: 'spawn' }, { from: 'research', to: 'research', kind: 'spawn' },
        { from: 'research', to: 'review', kind: 'send' }, { from: 'review', to: 'research', kind: 'send' },
        { from: 'review', to: 'research', kind: 'observe' },
      );
    }),
    editor: 'saved', rust: compiled,
  },
  {
    id: 'delegation-stronger-child', purpose: 'Delegation to a profile with other native permissions is refused.',
    source: 'derived from examples/systems/mixed-review.piui.json',
    text: derived('mixed-review.piui.json', (file) => { file.connections.push({ from: 'research', to: 'review', kind: 'spawn' }); }),
    editor: 'importRefused', rust: refused('delegationDenied', 'authorize_spawn: read-only cannot grant another harness native permissions'),
  },
  {
    id: 'delegation-network-escalation', purpose: 'Delegation to a child with network access the parent lacks.',
    source: 'derived from examples/systems/mixed-review.piui.json',
    text: derived('mixed-review.piui.json', (file) => {
      Object.assign(file.agents[1].profile, { harness: 'codex', permissionMode: 'read-only', networkAccess: true });
      file.connections.push({ from: 'research', to: 'review', kind: 'spawn' });
    }),
    editor: 'saved', rust: refused('delegationDenied', 'authorize_spawn: a child cannot gain network access'),
    difference: 'The editor\'s permissionsSubset does not compare network access, so it imports and offers to save this graph. The Desktop host refuses the save (validate_graph_request -> authorize_spawn), as the compiler does.',
  },
  {
    id: 'agent-router', purpose: 'An agent router returns its selection field as a text list after its other declared fields.',
    source: 'derived from examples/systems/routed-review.piui.json',
    text: derived('routed-review.piui.json', (file) => {
      const router = file.agents[1];
      router.profile.model = 'REPLACE_WITH_AVAILABLE_MODEL';
      router.router = { mode: 'agent', inputStepId: 'source', selectionField: 'routes', branches: [
        { id: 'ready', label: 'Ready', description: 'The change can ship.' },
        { id: 'needs-review', label: 'Needs review', description: 'A person should look first.' },
      ] };
      router.resultFields = [{ name: 'routes', kind: 'text' }, { name: 'reason', kind: 'text' }];
      delete router.requireApproval;
    }),
    editor: 'saved', rust: compiled,
  },
  {
    id: 'callable-role', purpose: 'A callable role without pipeline dependencies.',
    source: 'derived from examples/systems/mixed-review.piui.json',
    text: derived('mixed-review.piui.json', (file) => { file.connections = []; file.agents[1].executionMode = 'callable'; }),
    editor: 'saved', rust: compiled,
  },
  {
    id: 'profile-settings', purpose: 'Every optional profile member, an explicit empty task input and an explicit false team inheritance.',
    source: 'derived from examples/systems/mixed-review.piui.json',
    text: derived('mixed-review.piui.json', (file) => {
      Object.assign(file.agents[0].profile, {
        modelProvider: 'openai', baseInstructions: '', reasoning: 'high', serviceTier: 'fast', networkAccess: true,
        resourceRules: [{ kind: 'mcp', id: 'search', enabled: false }, { kind: 'skill', id: 'C:/skills/review', enabled: true }],
        whenToCall: 'When independent research is needed', inputInstructions: 'The question and its scope', expectedResult: 'Findings with evidence',
      });
      file.agents[0].input = '';
      file.agents[0].position = { x: 0, y: 250 };
      file.inheritTeamConnections = false;
    }),
    editor: 'saved', rust: compiled,
  },
  {
    id: 'plugin-node', purpose: 'A plugin node type with a flat configuration; a configuration number spelled 3.0 is the integer 3.',
    source: 'derived from examples/systems/agent-script-llm.piui.json',
    text: () => spell(derived('agent-script-llm.piui.json', (file) => {
      file.agents[1].executor = { type: 'plugin', pluginId: 'acme.audit', nodeType: 'count-lines', config: { label: 'dependencies', retries: 3, ratio: 0.5, strict: true } };
      file.agents[1].profile = { name: 'Count dependencies', harness: 'codex', model: 'plugin', permissionMode: 'read-only', instructions: '', toolPolicy: { rules: [] } };
    })(), '"retries": 3', '"retries": 3.0'),
    editor: 'saved', rust: compiled,
  },
  {
    id: 'subpipeline-name-folded', purpose: 'A sub-pipeline name resolved by a unique case-insensitive match, with run-input, step and value sources.',
    source: 'derived from examples/systems/development-with-testing.piui.json',
    text: derived('development-with-testing.piui.json', (file) => {
      file.agents[1].executor.pipeline = 'testing';
      file.agents[1].executor.inputs.focus = { kind: 'input', name: 'task' };
    }),
    pipelines: project, editor: 'saved', rust: compiled,
  },
  {
    id: 'subpipeline-missing', purpose: 'A sub-pipeline name the project does not have stays unresolved.',
    source: 'examples/systems/development-with-testing.piui.json', text: () => example('development-with-testing.piui.json'),
    pipelines: [{ id: 'cmd-release', name: 'Release check' }], editor: 'saveRefused', rust: refused('unresolvedPipeline', 'resolvePipelineName: no launch command named Testing'),
  },
  {
    id: 'subpipeline-ambiguous', purpose: 'Without an exact match, two case-insensitive matches leave the name unresolved.',
    source: 'derived from examples/systems/development-with-testing.piui.json',
    text: derived('development-with-testing.piui.json', (file) => { file.agents[1].executor.pipeline = 'testing'; }),
    pipelines: [...project, { id: 'cmd-other', name: 'TESTING' }], editor: 'saveRefused', rust: refused('unresolvedPipeline', 'resolvePipelineName: Testing and TESTING both fold to testing'),
  },
  {
    id: 'adapter-nano-reasoning', purpose: 'A setting the selected adapter does not support is carried into the definition, not dropped.',
    source: 'derived from examples/systems/codex-nano-pi-review.piui.json',
    text: derived('codex-nano-pi-review.piui.json', (file) => { file.agents[1].profile.reasoning = 'high'; }),
    editor: 'importRefused', rust: compiled,
    difference: 'Adapter checks (harness-adapters/validation.ts) refuse the import. The compiler does not repeat them: they are capability admission of the location that runs the step, and the native host refuses an unsupported setting before launch. The definition carries reasoning unchanged.',
  },
  {
    id: 'schema-unknown-member', purpose: 'An unknown member is refused, never dropped.',
    source: 'derived from examples/systems/mixed-review.piui.json',
    text: derived('mixed-review.piui.json', (file) => { file.agents[0].profile.apiKey = 'not-allowed'; }),
    editor: 'importRefused', rust: refused('invalidDocument', 'additionalProperties: false'),
  },
  {
    id: 'schema-explicit-null', purpose: 'An optional member written as null is refused, never read as absent.',
    source: 'derived from examples/systems/structured-review.piui.json',
    text: derived('structured-review.piui.json', (file) => { file.inputs[0].defaultValue = null; }),
    editor: 'importRefused', rust: refused('invalidDocument', 'defaultValue is a string, a number or a boolean'),
  },
  {
    id: 'program-router-message', purpose: 'A message edge from a program router, which has no team member.',
    source: 'derived from examples/systems/routed-review.piui.json',
    text: derived('routed-review.piui.json', (file) => { file.connections.push({ from: 'router', to: 'review', kind: 'send' }); }),
    editor: 'saved', rust: refused('invalidStructure', 'a program router has no team member and does not collaborate'),
    difference: 'The editor accepts the edge and compileGraph drops it (sendEdges stays empty). The compiler refuses it instead of dropping it.',
  },
  {
    id: 'llm-collaboration', purpose: 'A message edge into a single model call, which does not collaborate.',
    source: 'derived from examples/systems/agent-script-llm.piui.json',
    text: derived('agent-script-llm.piui.json', (file) => { file.connections.push({ from: 'audit', to: 'summary', kind: 'send' }); }),
    editor: 'importRefused', rust: refused('invalidStructure', 'EXECUTOR_ISSUES.noCollaboration: a step that is not an agent step does not collaborate'),
  },
  {
    id: 'cloud-server-proof', purpose: 'The server test document (HermesGraphExecutionTests.Document): cloud profiles, a result edge and an input binding.',
    source: 'NanoAgentProject.Tests/Services/Hermes/HermesGraphExecutionTests.cs (Document)',
    text: () => serverProof(),
    editor: 'saved', rust: compiled,
  },
  {
    id: 'cloud-routed-review', purpose: 'The routed-review example on cloud profiles; the program router keeps its placeholder profile.',
    source: 'derived from examples/systems/routed-review.piui.json', text: derived('routed-review.piui.json', cloudRouted),
    editor: 'saved', rust: compiled,
  },
  {
    id: 'cloud-structured-review-inputs', purpose: 'The structured-review example on cloud profiles with choice and number run inputs.',
    source: 'derived from examples/systems/structured-review.piui.json',
    text: derived('structured-review.piui.json', (file) => {
      cloudProfile(file.agents[0].profile);
      cloudProfile(file.agents[1].profile, 'smart');
      file.inputs.push({ name: 'depth', label: 'Depth', kind: 'choice', options: ['quick', 'deep'], defaultValue: 'quick' }, { name: 'budget', label: 'Budget', kind: 'number', defaultValue: 2.5 });
    }),
    editor: 'saved', rust: compiled,
  },
  {
    id: 'cloud-dependency-order', purpose: 'A step with a route connection listed before its result connection.',
    source: 'derived from examples/systems/routed-review.piui.json',
    text: derived('routed-review.piui.json', (file) => { cloudRouted(file); file.connections.push({ from: 'source', to: 'review', kind: 'result' }); }),
    editor: 'saved', rust: compiled,
  },
  {
    id: 'cloud-agent-router-first', purpose: 'Without an orchestrator, the first agent that is not a router orchestrates even when an agent router comes first.',
    source: 'constructed from the agent-router variant',
    text: () => `${JSON.stringify({ format: 'piui-system', version: 5, name: 'Triage first', agents: [
      { id: 'triage', kind: 'router', profile: { name: 'Triage', harness: 'hermes', model: 'auto', permissionMode: 'native', instructions: 'Pick the routes that apply.', toolPolicy: { rules: [] } },
        router: { mode: 'agent', inputStepId: 'intake', selectionField: 'routes', branches: [{ id: 'handle', label: 'Handle', description: 'The request is clear enough to act on.' }] }, task: 'Choose the routes.' },
      { id: 'intake', profile: { name: 'Intake', harness: 'hermes', model: 'fast', permissionMode: 'native', instructions: '', toolPolicy: { rules: [] } }, task: 'Summarize the request.', resultFields: [{ name: 'summary', kind: 'text' }] },
      { id: 'handler', executor: { type: 'agent' }, profile: { name: 'Handler', harness: 'hermes', model: 'auto', permissionMode: 'native', instructions: '', toolPolicy: { rules: [] } }, task: 'Handle the request.' },
    ], connections: [{ from: 'intake', to: 'triage', kind: 'result' }, { from: 'triage', to: 'handler', kind: 'route', branchId: 'handle' }] })}\n`,
    editor: 'saved', rust: compiled,
  },
  {
    id: 'cloud-number-spelling', purpose: 'Carried numbers spelled 2.0, 1.0 and 1.50 are the numbers JSON.parse reads: 2, 1 and 1.5.',
    source: 'derived from examples/systems/routed-review.piui.json',
    text: () => {
      const text = derived('routed-review.piui.json', (file) => {
        cloudRouted(file);
        file.agents[0].resultFields.push({ name: 'risk', kind: 'number' });
        file.agents[1].router.branches[0].predicate = { op: 'equals', field: 'risk', value: 2 };
        file.agents[2].condition = { sourceStepId: 'source', field: 'risk', equals: 1 };
        // Before the route connection, so that the dependency order is the same on both sides.
        file.connections.unshift({ from: 'source', to: 'review', kind: 'result' });
        file.inputs = [{ name: 'threshold', label: 'Threshold', kind: 'number', defaultValue: 1.5 }];
      })();
      return spell(spell(spell(text, '"value": 2', '"value": 2.0'), '"equals": 1', '"equals": 1.0'), '"defaultValue": 1.5', '"defaultValue": 1.50');
    },
    editor: 'saved', rust: compiled,
    serverNote: 'HermesGraphAdmission.Compile copies JSON nodes (DeepClone), which keep the spelling 2.0, 1.0 and 1.50 in the definition it sends to the kernel. serde_json reads 2.0 as a float, which is not equal to the integer 2 a native result carries, so the predicate and the condition would not match where the Desktop definition (2 and 1) does. Predicted, needs the C# characterization.',
  },
  {
    id: 'cloud-large-integer-serialization', purpose: 'Integral IEEE doubles serialize to the shortest ECMAScript decimal, not their exact binary integer value.',
    source: 'derived from examples/systems/routed-review.piui.json',
    text: derived('routed-review.piui.json', (file) => {
      cloudRouted(file);
      file.agents[0].resultFields.push({ name: 'risk', kind: 'number' });
      file.agents[1].router.branches[0].predicate = { op: 'equals', field: 'risk', value: 1000000000000000100 };
      file.agents[2].condition = { sourceStepId: 'source', field: 'risk', equals: -1000000000000000100 };
      file.connections.unshift({ from: 'source', to: 'review', kind: 'result' });
    }),
    editor: 'saved', rust: compiled,
  },
  {
    id: 'cloud-integer-spelling', purpose: 'A review limit spelled 3.0 is the integer 3.',
    source: 'derived from examples/systems/structured-review.piui.json',
    text: () => spell(derived('structured-review.piui.json', (file) => {
      cloudProfile(file.agents[0].profile);
      cloudProfile(file.agents[1].profile);
    })(), '"maxIterations": 3', '"maxIterations": 3.0'),
    editor: 'saved', rust: compiled,
    serverNote: 'Compile copies "maxIterations": 3.0 unchanged (the stored definition shows the 3 that JSON.parse reads). Kernel protocol 1 decodes ReviewRule.max_iterations as an unsigned integer and refuses 3.0, so the create frame does not decode. Predicted, needs the C# characterization.',
    serverKernel: { outcome: 'refused', code: 'kernel_invalid_response', reason: 'the create frame does not decode: the kernel answers invalidRequest without a request id' },
  },
  {
    id: 'orchestrator-program-router', purpose: 'A program router named as the orchestrator.',
    source: 'derived from examples/systems/routed-review.piui.json',
    text: derived('routed-review.piui.json', (file) => { cloudRouted(file); file.orchestrator = 'router'; }),
    editor: 'saved', rust: refused('invalidStructure', 'a program router has no team member and cannot be the orchestrator'),
    difference: 'The editor accepts it and compileGraph replaces the orchestrator with the first team member (source). The compiler refuses it instead of replacing it.',
  },
  {
    id: 'duplicate-member-name', purpose: 'A member name repeated in one object.',
    source: 'derived from the cloud-server-proof document',
    text: () => spell(serverProof(), '"task":"First task"', '"task":"Ignored task","task":"First task"'),
    editor: 'saved', rust: refused('invalidDocument', 'a member name is repeated'),
    difference: 'JSON.parse keeps the last value silently, so the editor imports the second task. The compiler refuses the document.',
    serverNote: 'Predicted: the draft validator accepts it (JsonDocument keeps both members and both are valid strings). Compile parses it with JsonNode.Parse; reading a JsonObject with a repeated name is expected to throw ArgumentException, which is not the JsonException that Compile turns into invalidDefinition, so StartAsync fails without a refusal code. Needs the C# characterization.',
    serverCompile: { outcome: 'uncertain', expected: 'ArgumentException (repeated member name) escapes Compile; not a HermesGraphRejectedException' },
  },
  {
    id: 'name-next-line', purpose: 'A name that is only U+0085 (NEXT LINE): not whitespace to JavaScript, whitespace to Rust\'s str::trim.',
    source: 'derived from the cloud-server-proof document',
    text: () => serverProof((file) => { file.name = '\u0085'; }),
    editor: 'saved', rust: refused('invalidDefinition', 'validate_definition: the team name is blank to str::trim'),
    difference: 'The schema pattern \\S and String.prototype.trim do not treat U+0085 as whitespace, so the editor imports and offers to save the graph. validate_definition uses Rust\'s str::trim (Unicode White_Space includes U+0085), so the Desktop host refuses the save, as the compiler does.',
    serverNote: 'Predicted from JavaScript regular expressions. .NET\'s \\s includes U+0085 unless the pattern runs with RegexOptions.ECMAScript, so HermesGraphDocumentValidator may refuse the draft instead. If the draft is accepted, the kernel refuses the definition.',
    serverKernel: { outcome: 'refused', code: 'invalidDefinition', reason: 'validate_definition: the team name is blank to str::trim' },
  },
  {
    id: 'name-byte-order-mark', purpose: 'A name that is only U+FEFF: whitespace to JavaScript\'s \\s, not to .NET\'s \\s or Rust\'s str::trim.',
    source: 'derived from the cloud-server-proof document',
    text: () => serverProof((file) => { file.name = '﻿'; }),
    editor: 'importRefused', rust: refused('invalidDocument', 'schema pattern \\S, read with JavaScript\'s whitespace set'),
    serverDraft: 'accepted',
    serverNote: 'Predicted: .NET regular expressions do not treat U+FEFF as whitespace (with or without RegexOptions.ECMAScript), so HermesGraphDocumentValidator accepts a draft that the editor and the compiler refuse; Compile accepts it and the kernel creates the run (str::trim keeps U+FEFF). Needs the C# characterization.',
  },
  {
    id: 'nesting-beyond-parser-limit', purpose: 'A predicate nested 130 levels deep, beyond serde_json\'s recursion limit.',
    source: 'derived from examples/systems/routed-review.piui.json',
    text: derived('routed-review.piui.json', (file) => { cloudRouted(file); file.agents[1].router.branches[0].predicate = nestedNot(130); }, 'compact'),
    editor: 'saved', rust: refused('invalidJson', 'serde_json recursion limit (also applied by kernel protocol 1)'),
    difference: 'The editor and the server read any depth. The compiler, like kernel protocol 1, stops at serde_json\'s default recursion limit instead of risking its stack.',
    serverNote: 'Predicted: the draft validator and Compile accept it (MaxDepth is the source length and int.MaxValue). Kernel protocol 1 cannot decode the create frame (the same serde_json recursion limit).',
    serverKernel: { outcome: 'refused', code: 'kernel_invalid_response', reason: 'the create frame does not decode: the kernel answers invalidRequest without a request id' },
    omitDefinition: 'The 130-level definitions are not stored: the compiler refuses this document, and a reader with serde_json\'s recursion limit could not read this file.',
  },
  {
    id: 'rule-condition-through-route', purpose: 'Editor rule: a condition reads a result dependency, not a router reached by a route connection.',
    source: 'derived from examples/systems/routed-review.piui.json',
    text: derived('routed-review.piui.json', (file) => {
      cloudRouted(file);
      file.agents[2].condition = { sourceStepId: 'router', field: 'selectedBranchIds', equals: 'ready' };
    }),
    editor: 'importRefused', rust: refused('invalidDefinition', 'graphIssues: a condition selects a declared field of a result dependency'),
  },
  {
    id: 'rule-binding-through-route', purpose: 'Editor rule: an input binding reads a result dependency, not a router reached by a route connection.',
    source: 'derived from examples/systems/routed-review.piui.json',
    text: derived('routed-review.piui.json', (file) => {
      cloudRouted(file);
      file.agents[2].inputBindings = [{ sourceStepId: 'router', field: 'selectedBranchIds', name: 'routes' }];
    }),
    editor: 'importRefused', rust: refused('invalidDefinition', 'graphIssues: input bindings select declared fields of result dependencies'),
  },
  {
    id: 'rule-review-through-route', purpose: 'Editor rule: beyond the direct dependencies, a review\'s correction step is found through result connections only.',
    source: 'derived from examples/systems/routed-review.piui.json',
    text: derived('routed-review.piui.json', (file) => {
      cloudRouted(file);
      const check = { id: 'check', profile: structuredClone(file.agents[2].profile), task: 'Check the review.', resultFields: [{ name: 'accepted', kind: 'boolean' }], review: { field: 'accepted', retryFromStepId: 'source' } };
      check.profile.name = 'Check';
      file.agents.push(check);
      file.connections.push({ from: 'review', to: 'check', kind: 'result' });
    }),
    editor: 'importRefused', rust: refused('invalidDefinition', 'graphIssues: a review needs an upstream correction step'),
  },
  {
    id: 'rule-output-field-undeclared', purpose: 'Editor rule: an output field must be declared by its step, also when the step declares no field at all.',
    source: 'derived from examples/systems/testing.piui.json',
    text: derived('testing.piui.json', (file) => { cloudProfile(file.agents[0].profile); delete file.agents[0].resultFields; }),
    editor: 'importRefused', rust: refused('invalidDefinition', 'pipelineOutputIssues: an output reads a declared field'),
  },
  {
    id: 'rule-subpipeline-field-undeclared', purpose: 'Editor rule: a sub-pipeline step source reads a field its agent declares.',
    source: 'derived from examples/systems/development-with-testing.piui.json',
    text: derived('development-with-testing.piui.json', (file) => { file.agents[1].executor.inputs.changes.field = 'undeclared'; }),
    pipelines: project, editor: 'importRefused', rust: refused('invalidDefinition', 'mappingProblems: a step source reads a declared field'),
  },
  {
    id: 'rule-predicate-on-added-field', purpose: 'Editor rule: program router predicates use the fields their input declares, not the selection field added to an agent router.',
    source: 'constructed from the agent-router variant',
    text: () => `${JSON.stringify({ format: 'piui-system', version: 5, name: 'Two routers', agents: [
      { id: 'intake', profile: { name: 'Intake', harness: 'hermes', model: 'auto', permissionMode: 'native', instructions: '', toolPolicy: { rules: [] } }, task: 'Summarize the request.', resultFields: [{ name: 'summary', kind: 'text' }] },
      { id: 'triage', kind: 'router', profile: { name: 'Triage', harness: 'hermes', model: 'auto', permissionMode: 'native', instructions: '', toolPolicy: { rules: [] } },
        router: { mode: 'agent', inputStepId: 'intake', selectionField: 'routes', branches: [{ id: 'handle', label: 'Handle', description: 'The request is clear.' }] }, task: 'Choose the routes.' },
      { id: 'gate', kind: 'router', profile: { name: 'Gate', harness: 'codex', model: 'router', permissionMode: 'read-only', instructions: '', toolPolicy: { rules: [] } },
        router: { mode: 'program', inputStepId: 'triage', branches: [{ id: 'go', label: 'Go', predicate: { op: 'exists', field: 'routes' } }] }, task: 'Continue when routes were chosen.' },
      { id: 'worker', profile: { name: 'Worker', harness: 'hermes', model: 'auto', permissionMode: 'native', instructions: '', toolPolicy: { rules: [] } }, task: 'Do the work.' },
    ], connections: [{ from: 'intake', to: 'triage', kind: 'result' }, { from: 'triage', to: 'gate', kind: 'result' }, { from: 'gate', to: 'worker', kind: 'route', branchId: 'go' }] })}\n`,
    editor: 'importRefused', rust: refused('invalidDefinition', 'graphIssues: program router predicates use declared input fields'),
  },
  {
    id: 'rule-duplicate-declared-field', purpose: 'Editor rule: declared result fields are unique, also when the selection field would replace the duplicates.',
    source: 'derived from examples/systems/routed-review.piui.json',
    text: derived('routed-review.piui.json', (file) => {
      cloudRouted(file);
      const router = file.agents[1];
      cloudProfile(router.profile);
      router.router = { mode: 'agent', inputStepId: 'source', selectionField: 'routes', branches: [{ id: 'needs-review', label: 'Needs review', description: 'A person should look first.' }] };
      router.resultFields = [{ name: 'routes', kind: 'text' }, { name: 'routes', kind: 'text' }];
      delete router.requireApproval;
    }),
    editor: 'importRefused', rust: refused('invalidDefinition', 'graphIssues: result fields need unique names'),
  },
];

/** A vector of the file: one document, what the editor produced and what the compiler and the server are expected to do. */
export interface CompileVector {
  readonly id: string;
  readonly purpose: string;
  readonly source: string;
  readonly sourceVersion: number;
  /** The shipped text of a version 1-4 document; the compiler refuses it (`unsupportedVersion`). */
  readonly original?: string;
  /** The version 5 text the compiler reads. For versions 1-4, the editor's export of the imported graph. */
  readonly document: string;
  readonly pipelines: readonly GraphPipelineNameV2[];
  readonly typescript: EditorOutcome;
  readonly rust: Expected;
  readonly difference?: string;
  readonly server: ServerPrediction;
}

type EditorOutcome =
  | { readonly import: 'accepted'; readonly save: 'accepted'; readonly definition?: RunDefinitionSnapshot; readonly definitionOmitted?: string }
  | { readonly import: 'accepted'; readonly save: 'refused'; readonly issues: readonly string[] }
  | { readonly import: 'refused'; readonly issues: readonly string[]; readonly mappingWithoutImportChecks?: RunDefinitionSnapshot };

interface Difference { readonly path: string; readonly csharp: unknown; readonly rust: unknown }

/** Kernel protocol 1 `create` with the definition Compile built and `HermesGraphAdmission.Capabilities`. */
type KernelPrediction =
  | { readonly outcome: 'created' }
  | { readonly outcome: 'refused'; readonly code: string; readonly reason: string };

type ServerCompile =
  | { readonly outcome: 'refused'; readonly code: string }
  | { readonly outcome: 'uncertain'; readonly expected: string }
  | {
    readonly outcome: 'accepted';
    /** The definition Compile builds, as JSON.parse reads it (number spelling is not kept). */
    readonly definition?: Json;
    readonly definitionOmitted?: string;
    /** Against the compiler's definition for the server identity, ignoring members equal to their Rust default. */
    readonly differencesFromRust?: readonly Difference[];
    readonly kernel: KernelPrediction;
  };

interface ServerPrediction {
  readonly status: 'predicted';
  readonly draftSave: 'accepted' | 'refused';
  readonly compile?: ServerCompile;
  readonly note?: string;
}

const messages = (error: unknown): string[] => (error instanceof Error ? error.message : String(error)).split('\n');

/**
 * Renames the identifiers `emptyGraph` and `systemFileToGraph` generate at
 * random, one to one: team, pipeline and graph (launch command) ids to the
 * host identity, each agent's profile id to the agent id. Only id positions
 * are renamed; any generated id left anywhere else fails generation.
 */
export function normalize(graph: AgentGraph, identity: Required<GraphCompileIdentityV2>): RunDefinitionSnapshot {
  const compiled = compileGraph(graph);
  const ids = new Map<string, string>([[graph.teamId, identity.teamId], [graph.pipelineId, identity.pipelineId], [graph.id, identity.launchCommandId]]);
  for (const node of graph.nodes) ids.set(node.profile.id, node.id);
  const targets = [...ids.values()];
  if (ids.size !== 3 + graph.nodes.length || new Set(targets).size !== targets.length) throw new Error('The identifier mapping is not one to one.');
  const id = (value: string): string => {
    const mapped = ids.get(value);
    if (mapped === undefined) throw new Error('An id position holds an identifier the editor did not generate.');
    return mapped;
  };
  const definition: RunDefinitionSnapshot = {
    profiles: compiled.profiles.map((profile) => ({ ...profile, id: id(profile.id), allowedSpawnProfileIds: profile.allowedSpawnProfileIds.map(id) })),
    team: { ...compiled.team, id: id(compiled.team.id), members: compiled.team.members.map((member) => ({ ...member, profileId: id(member.profileId) })) },
    pipeline: { ...compiled.pipeline, id: id(compiled.pipeline.id) },
    launchCommand: { ...compiled.command, id: id(compiled.command.id), teamId: id(compiled.command.teamId), pipelineId: id(compiled.command.pipelineId) },
  };
  const text = JSON.stringify(definition);
  for (const generated of ids.keys()) if (text.includes(generated)) throw new Error('A generated identifier remains outside an id position.');
  return definition;
}

function editorOutcome(document: string, pipelines: readonly GraphPipelineNameV2[], wantMapping: boolean): EditorOutcome {
  let file: SystemFile;
  try {
    file = parseSystemFile(document);
  } catch (error) {
    if (!wantMapping) return { import: 'refused', issues: messages(error) };
    // The mapping alone, without the import checks that refused the document.
    return { import: 'refused', issues: messages(error), mappingWithoutImportChecks: normalize(systemFileToGraph(parseJson(document) as SystemFile, pipelines), VECTOR_IDENTITY) };
  }
  const graph = systemFileToGraph(file, pipelines);
  const issues = graphIssues(graph).map((issue) => issue.message);
  if (issues.length) return { import: 'accepted', save: 'refused', issues };
  return { import: 'accepted', save: 'accepted', definition: normalize(graph, VECTOR_IDENTITY) };
}

// ---------------------------------------------------------------------------
// Server predictions: HermesGraphDocumentValidator.Validate (the v5 schema)
// and HermesGraphAdmission.Compile at NanoAgentProject c20e7721, in the
// order their checks run.
// ---------------------------------------------------------------------------

/** `HermesGraphAdmission.EnsureProfile`. */
function serverCloudProfile(profile: Json): boolean {
  return profile.harness === 'hermes' && profile.permissionMode === 'native' && ['auto', 'free', 'fast', 'smart'].includes(profile.model)
    && !['modelProvider', 'reasoning', 'serviceTier', 'baseInstructions', 'networkAccess'].some((key) => key in profile)
    && !(Array.isArray(profile.resourceRules) && profile.resourceRules.length > 0)
    && !(Array.isArray(profile.toolPolicy?.rules) && profile.toolPolicy.rules.length > 0)
    && !(Array.isArray(profile.allowedSpawnProfileIds) && profile.allowedSpawnProfileIds.length > 0);
}

/** `HermesGraphAdmission.CompileDocument`: a refusal code or the definition it builds. */
function serverCompile(file: Json): { readonly code: string } | { readonly definition: Json } {
  const agents: Json[] = file.agents;
  const edges: Json[] = file.connections;
  if (file.inheritTeamConnections === true || edges.some((edge) => edge.kind !== 'result' && edge.kind !== 'route')) return { code: 'unsupported_cloud_delegation' };
  const ids = new Set(agents.map((agent) => agent.id));
  if (ids.size !== agents.length || edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))) return { code: 'invalidDefinition' };
  const profiles: Json[] = [];
  const members: Json[] = [];
  const steps: Json[] = [];
  for (const agent of agents) {
    const program = agent.kind === 'router' && agent.router?.mode === 'program';
    if (agent.executor?.type !== undefined && agent.executor.type !== 'agent') return { code: 'unsupported_cloud_executor' };
    if (agent.executionMode === 'callable') return { code: 'unsupported_cloud_delegation' };
    if (!program) {
      if (!serverCloudProfile(agent.profile)) return { code: 'unsupported_cloud_profile' };
      profiles.push({ ...structuredClone(agent.profile), id: agent.id, allowedSpawnProfileIds: [] });
      members.push({ id: agent.id, profileId: agent.id });
    }
    const routes = edges.filter((edge) => edge.kind === 'route' && edge.to === agent.id);
    const step: Json = { id: agent.id, name: agent.profile.name, assignedMemberId: agent.id, instructions: agent.task,
      dependencyStepIds: [...new Set(edges.filter((edge) => edge.to === agent.id).map((edge) => edge.from))] };
    for (const key of ['inputBindings', 'condition', 'router', 'review', 'requireApproval', 'resultFields', 'executionMode', 'executor']) {
      if (key in agent) step[key] = structuredClone(agent[key]);
    }
    if ('input' in agent) step.inputInstructions = agent.input;
    if (routes.length > 0) step.routeGates = routes.map((edge) => ({ routerStepId: edge.from, branchId: edge.branchId ?? null }));
    if (agent.kind !== 'router' && 'router' in agent) return { code: 'invalidDefinition' };
    if (agent.kind === 'router' && agent.router == null) return { code: 'invalidDefinition' };
    if (agent.router?.mode === 'agent') {
      const selection = agent.router.selectionField ?? 'selectedBranchIds';
      step.resultFields = [...(step.resultFields ?? []).filter((field: Json) => field.name !== selection), { name: selection, kind: 'text-list' }];
    }
    steps.push(step);
  }
  const orchestrator = file.orchestrator ?? members[0]?.id ?? '';
  if (!members.some((member) => member.id === orchestrator)) return { code: 'invalidDefinition' };
  const pipeline: Json = { id: SERVER_DRAFT_ID, name: file.name, steps };
  if (file.inputs !== undefined) pipeline.inputs = structuredClone(file.inputs);
  if (Array.isArray(file.outputs)) pipeline.outputs = file.outputs.map(({ agent, ...output }: Json) => ({ ...output, sourceStepId: agent }));
  return { definition: { profiles, pipeline, team: { id: SERVER_DRAFT_ID, name: file.name, members, orchestratorMemberId: orchestrator, sendEdges: [], observeEdges: [] } } };
}

/** The Rust definition a server identity produces: team and pipeline ids are the draft id; no launch command. */
export function serverIdentityDefinition(definition: RunDefinitionSnapshot): RunDefinitionSnapshot {
  const { launchCommand: _launchCommand, ...rest } = definition;
  return { ...rest, team: { ...definition.team, id: SERVER_DRAFT_ID }, pipeline: { ...definition.pipeline, id: SERVER_DRAFT_ID } };
}

/**
 * Members whose value is the default of their orchestration v6 Rust type,
 * so that their presence does not change the typed definition.
 */
function withoutDefaults(definition: Json): Json {
  const value = structuredClone(definition);
  const drop = (object: Json, keys: readonly string[]) => {
    for (const key of keys) if (object[key] === false || (Array.isArray(object[key]) && object[key].length === 0)) delete object[key];
  };
  for (const profile of value.profiles) drop(profile, ['networkAccess', 'resourceRules']);
  drop(value.team, ['spawnedAgentsJoinTeam']);
  drop(value.pipeline, ['inputs', 'outputs']);
  for (const input of value.pipeline.inputs ?? []) drop(input, ['required', 'options']);
  for (const step of value.pipeline.steps) drop(step, ['inputBindings', 'routeGates', 'requireApproval', 'resultFields']);
  return value;
}

function differences(csharp: unknown, rust: unknown, path: string, found: Difference[]): void {
  const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  if (Array.isArray(csharp) && Array.isArray(rust)) {
    if (csharp.length !== rust.length || csharp.some((item) => !object(item) && !Array.isArray(item))) {
      if (JSON.stringify(csharp) !== JSON.stringify(rust)) found.push({ path, csharp, rust });
      return;
    }
    csharp.forEach((item, index) => differences(item, rust[index], `${path}[${index}]`, found));
    return;
  }
  if (object(csharp) && object(rust)) {
    for (const key of [...new Set([...Object.keys(csharp), ...Object.keys(rust)])].sort()) differences(csharp[key], rust[key], path ? `${path}.${key}` : key, found);
    return;
  }
  if (JSON.stringify(csharp) !== JSON.stringify(rust)) found.push({ path, csharp, rust });
}

function predictServer(document: string, rustDefinition: RunDefinitionSnapshot | undefined, testCase: CompileCase): ServerPrediction {
  const file = parseJson(document);
  const base = { status: 'predicted' as const, ...(testCase.serverNote ? { note: testCase.serverNote } : {}) };
  if (!(testCase.serverDraft ? testCase.serverDraft === 'accepted' : validateV5(file))) return { ...base, draftSave: 'refused' };
  if (testCase.serverCompile) return { ...base, draftSave: 'accepted', compile: testCase.serverCompile };
  const result = serverCompile(file);
  if ('code' in result) return { ...base, draftSave: 'accepted', compile: { outcome: 'refused', code: result.code } };
  const kernel = testCase.serverKernel ?? { outcome: 'created' as const };
  const stored = testCase.omitDefinition !== undefined ? { definitionOmitted: testCase.omitDefinition } : { definition: result.definition };
  if (rustDefinition === undefined) return { ...base, draftSave: 'accepted', compile: { outcome: 'accepted', ...stored, kernel } };
  const found: Difference[] = [];
  differences(withoutDefaults(result.definition), withoutDefaults(serverIdentityDefinition(rustDefinition)), '', found);
  return { ...base, draftSave: 'accepted', compile: { outcome: 'accepted', ...stored, differencesFromRust: found, kernel } };
}

function vector(testCase: CompileCase): CompileVector {
  const pipelines = testCase.pipelines ?? [];
  const text = testCase.text();
  const sourceVersion = parseJson(text).version as number;
  let document = text;
  let original: string | undefined;
  if (sourceVersion !== GRAPH_COMPILE_DOCUMENT_VERSION_V2) {
    original = text;
    document = serializeSystemFile(systemFileToGraph(parseSystemFile(text), pipelines), pipelines);
    // The editor's upgrade keeps the definition it imported.
    const before = normalize(systemFileToGraph(parseSystemFile(text), pipelines), VECTOR_IDENTITY);
    const after = normalize(systemFileToGraph(parseSystemFile(document), pipelines), VECTOR_IDENTITY);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`${testCase.id}: the version 5 export changes the definition.`);
  }
  const ids = new Set<string>(parseJson(document).agents.map((agent: Json) => agent.id));
  if (Object.values(VECTOR_IDENTITY).some((value) => ids.has(value))) throw new Error(`${testCase.id}: an agent id equals a host identity id.`);
  const typescript = editorOutcome(document, pipelines, testCase.rust.outcome === 'compiled');
  const editor: Editor = typescript.import === 'refused' ? 'importRefused' : typescript.save === 'refused' ? 'saveRefused' : 'saved';
  if (editor !== testCase.editor) throw new Error(`${testCase.id}: the editor's outcome is ${editor}, not ${testCase.editor}.`);
  const agrees = (editor === 'saved') === (testCase.rust.outcome === 'compiled');
  if (agrees === (testCase.difference !== undefined)) throw new Error(`${testCase.id}: a difference is described exactly when the editor and the compiler disagree.`);
  if (testCase.rust.outcome === 'refused' && !(GRAPH_COMPILE_REFUSALS_V2 as readonly string[]).includes(testCase.rust.refusal)) throw new Error(`${testCase.id}: unknown refusal.`);
  const rustDefinition = testCase.rust.outcome !== 'compiled' ? undefined
    : typescript.import === 'accepted' && typescript.save === 'accepted' ? typescript.definition
      : typescript.import === 'refused' ? typescript.mappingWithoutImportChecks : undefined;
  if (testCase.rust.outcome === 'compiled' && rustDefinition === undefined) throw new Error(`${testCase.id}: no definition to compare with.`);
  let stored = typescript;
  if (testCase.omitDefinition !== undefined) {
    if (testCase.rust.outcome === 'compiled' || typescript.import !== 'accepted' || typescript.save !== 'accepted') throw new Error(`${testCase.id}: only a refused case may omit the definition.`);
    stored = { import: 'accepted', save: 'accepted', definitionOmitted: testCase.omitDefinition };
  }
  return {
    id: testCase.id, purpose: testCase.purpose, source: testCase.source, sourceVersion,
    ...(original !== undefined ? { original } : {}),
    document, pipelines, typescript: stored, rust: testCase.rust,
    ...(testCase.difference !== undefined ? { difference: testCase.difference } : {}),
    server: predictServer(document, rustDefinition, testCase),
  };
}

export function generateCompileVectors() {
  const vectors = COMPILE_CASES.map(vector);
  if (new Set(vectors.map((item) => item.id)).size !== vectors.length) throw new Error('Vector ids must be unique.');
  return {
    format: 'piui-graph-compile-vectors',
    version: 1,
    contract: 'contracts/nano-graph-kernel-v2.ts',
    adr: 'docs/adr/059-graph-kernel-v2.md',
    generator: 'apps/desktop/src/features/orchestration/compileVectors.ts',
    regenerate: 'pnpm --filter @piui/desktop exec vitest run src/features/orchestration/compileVectors.test.ts --update',
    typescriptPath: 'parseSystemFile(document) -> systemFileToGraph(file, pipelines) -> graphIssues(graph) must be empty -> compileGraph(graph); the definition is {profiles, team, pipeline, launchCommand: command}, the snapshot the Desktop host validates when it saves a graph.',
    normalization: 'Only identifiers the editor generates at random are renamed, one to one: graph.teamId to identity.teamId, graph.pipelineId to identity.pipelineId, graph.id (the launch command) to identity.launchCommandId, and the profile id of each agent to the agent id, in id positions only. No other value is changed.',
    derivedDocuments: 'A derived document starts from the version 5 text of its example: the example itself (version 5) or the editor\'s export of it (versions 1-4), then applies the change its purpose describes.',
    comparison: 'The Rust compiler must return a definition equal, as orchestration v6 Rust types, to typescript.definition (or typescript.mappingWithoutImportChecks), or exactly the refusal in rust.refusal. original, when present, must be refused as unsupportedVersion.',
    identity: VECTOR_IDENTITY,
    server: {
      status: 'predicted: read from NanoAgentProject c20e7721 source; the server test HermesGraphCompilerParityTests executes them, this file does not',
      sources: ['NanoAgentProject/Services/Hermes/Graphs/HermesGraphDocumentValidator.cs', 'NanoAgentProject/Services/Hermes/Graphs/HermesGraphAdmission.cs'],
      draftId: SERVER_DRAFT_ID,
      identity: { teamId: SERVER_DRAFT_ID, pipelineId: SERVER_DRAFT_ID },
      draftSave: 'HermesGraphDocumentValidator.Validate: predicted from the same v5 schema with Ajv.',
      compile: 'HermesGraphAdmission.Compile(document, draftId): a refusal code, or the definition it builds (mirrored in compileVectors.ts), compared with the Rust definition under server.identity.',
      differencesIgnore: 'Members equal to their Rust type default are not differences: profiles[].networkAccess false and resourceRules [], team.spawnedAgentsJoinTeam false, pipeline.inputs and outputs [], pipeline.inputs[].required false and options [], pipeline.steps[].inputBindings, routeGates and resultFields [] and requireApproval false.',
      kernel: 'Kernel protocol 1 create with that definition and HermesGraphAdmission.Capabilities (native permissions, no tools, no agent operations), assuming the workspace offers the model modes and the request supplies valid run inputs (EnsureExecutionAsync and the inputs are request and workspace state, not document data). piui-orchestration compile_tests checks each created prediction: the definition decodes, passes the protocol 1 support checks, validate_profile_capabilities and validate_definition.',
    },
    vectors,
  };
}
