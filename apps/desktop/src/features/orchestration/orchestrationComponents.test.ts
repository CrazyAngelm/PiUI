import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import AgentProfileEditor from './AgentProfileEditor.svelte';
import TeamEditor from './TeamEditor.svelte';
import PipelineEditor from './PipelineEditor.svelte';
import LaunchCommandEditor from './LaunchCommandEditor.svelte';
import ScheduleEditor from './ScheduleEditor.svelte';
import OrchestrationPanel from './OrchestrationPanel.svelte';
import type { AgentProfile, TeamDefinition, PipelineDefinition } from '../../../../../contracts/orchestration-v6';

const profile: AgentProfile = {
  id: 'fixture-profile', name: 'Fixture review', harness: 'prime-agent', model: 'fixture-model', permissionMode: 'read-only',
  instructions: '<img src=x onerror=alert(1)>', toolPolicy: { rules: [{ tool: 'ipython', decision: 'deny', enforcement: 'unsupported', mandatory: true }] },
  allowedSpawnProfileIds: [],
};
const team: TeamDefinition = {
  id: 'fixture-team', name: 'Fixture team', members: [{ id: 'reviewer', profileId: profile.id }],
  sendEdges: [], observeEdges: [], orchestratorMemberId: 'reviewer',
};
const pipeline: PipelineDefinition = {
  id: 'fixture-pipeline', name: 'Fixture pipeline', steps: [{ id: 'review', name: 'Review', assignedMemberId: 'reviewer', instructions: 'Review the result', dependencyStepIds: [] }],
};
const noAction = () => {};

describe('orchestration component integration', () => {
  it('renders an unsupported native profile with labelled policy controls and escaped instructions', () => {
    const { body } = render(AgentProfileEditor, { props: { profile, profiles: [profile], error: 'Save rejected. Draft retained.', onSave: noAction, onCancel: noAction } });
    expect(body).toContain('Save rejected. Draft retained.');
    expect(body).toContain('role="alert"');
    expect(body).toContain('Read-only');
    expect(body).toContain('Unsupported');
    expect(body).not.toContain('<img src=x onerror=alert(1)>');
    expect(body).toContain('&lt;img');
  });
  it('keeps team message and observation direction separate from workspace spawning', () => {
    const { body } = render(TeamEditor, { props: { team, profiles: [profile], error: undefined, onSave: noAction, onCancel: noAction, readOnly: true } });
    expect(body).toContain('Messaging');
    expect(body).toContain('Observation');
    expect(body).toContain('Subagents');
    expect(body).toContain('disabled');
    expect(body).not.toContain('>Start run<');
  });
  it('renders a saved pipeline dependency view and keeps a failed-save notice beside the draft', () => {
    const { body } = render(PipelineEditor, { props: { pipeline, teams: [team], profiles: [profile], error: 'Revision conflict. Keep your draft.', onSave: noAction, onCancel: noAction } });
    expect(body).toContain('Dependency order');
    expect(body).toContain('Assigned agent');
    expect(body).toContain('Review the result');
    expect(body).toContain('Revision conflict. Keep your draft.');
    expect(body).toContain('Save pipeline');
  });
  it('renders reusable launch references without shell fields or executable runtime controls', () => {
    const { body } = render(LaunchCommandEditor, { props: { command: undefined, teams: [], pipelines: [], onSave: noAction, onCancel: noAction } });
    expect(body).toContain('not a shell command');
    expect(body).toContain('Create a team and a pipeline');
    expect(body).toContain('Save launch command');
    expect(body).not.toContain('>Start run<');
  });
  it('renders schedule timing and policy choices without enabling execution on save', () => {
    const { body } = render(ScheduleEditor, { props: {
      schedule: undefined,
      launchCommands: [{ id: 'launch', name: 'Nightly review', revision: 2 }],
      onSave: noAction,
      onCancel: noAction,
    } });
    expect(body).toContain('Once at a date and time');
    expect(body).toContain('After PiUI was closed');
    expect(body).toContain('While a previous run is active');
    expect(body).toContain('Saving does not enable execution');
    expect(body).not.toContain('Enable schedule');
  });
  it('keeps the core-safe panel read-only and does not fabricate a run for empty server rendering', () => {
    const { body } = render(OrchestrationPanel, { props: { workspaceId: 'fixture-workspace', section: 'runs', safeMode: true } });
    expect(body).toContain('Safe mode. Definitions and recorded runs are read-only.');
    expect(body).not.toContain('Create profile');
    expect(body).not.toContain('Fixture pipeline');
  });
});
