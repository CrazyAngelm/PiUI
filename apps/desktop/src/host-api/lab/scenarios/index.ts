import { firstRunHarnesses, readyHarnesses } from '../catalogFake';
import { labUuid } from '../labRandom';
import type { LabScenarioName } from '../labState';
import { restoreInterrupted } from '../orchestration/runEngine';
import { demoChats, demoProjects } from './demoChats';
import { demoPiHistory } from './demoPiHistory';
import { demoSystems } from './demoSystems';
import { longSeed } from './longScenario';
import type { LabSeed } from './seedTypes';

export type { LabSeed, SeedActivity } from './seedTypes';

/**
 * `demo`: four projects, thirteen chats on all five harnesses, two saved agent
 *   systems, schedules and runs (succeeded, failed, running, awaiting approval).
 * `empty`: first run — only the host-owned Chats workspace, nothing saved.
 * `safe`: the demo after a restart in safe mode: every runtime closed,
 *   interrupted runs restored to "needs reconciliation", actions refused.
 * `long`: one ~3,000-block transcript for performance work.
 */
function demoSeed(): LabSeed {
  const chats = demoChats();
  const systems = demoSystems();
  return {
    safeMode: false,
    projects: demoProjects(),
    harnesses: readyHarnesses(),
    sessions: [...chats.sessions, ...systems.sessions],
    orchestration: systems.orchestration,
    activity: [...chats.activity, ...systems.activity],
    nativeHistory: demoPiHistory(),
  };
}

function emptySeed(): LabSeed {
  return {
    safeMode: false,
    projects: [{
      id: labUuid('empty:project:chats'), name: 'Chats', displayPath: '~/.piui-lab/chats', agentKind: 'pi',
      trustState: 'trusted', pinned: false, missing: false, personal: true,
    }],
    harnesses: firstRunHarnesses(),
    sessions: [],
    orchestration: [],
    activity: [],
  };
}

/** Safe mode starts no runtime; the host's recovery marks interrupted work uncertain. */
function safeSeed(): LabSeed {
  const seed = demoSeed();
  for (const record of seed.sessions) delete record.live;
  for (const workspace of seed.orchestration) workspace.runs.forEach(restoreInterrupted);
  return { ...seed, safeMode: true, activity: [] };
}

export function buildSeed(scenario: LabScenarioName): LabSeed {
  switch (scenario) {
    case 'demo': return demoSeed();
    case 'empty': return emptySeed();
    case 'safe': return safeSeed();
    case 'long': return longSeed();
    default: {
      const exhaustive: never = scenario;
      return exhaustive;
    }
  }
}
