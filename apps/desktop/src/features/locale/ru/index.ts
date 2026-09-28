import { acpRu } from './acp';
import { boardRu } from './board';
import { chatRu } from './chat';
import { chatPipelinesRu } from './chatPipelines';
import { classicRu } from './classic';
import { executorsRu } from './executors';
import { harnessesRu } from './harnesses';
import { pluginsRu } from './plugins';
import { releaseRu } from './release';
import { runsRu } from './runs';
import { sessionRu } from './session';
import { teamRu } from './team';
import { triggersRu } from './triggers';

/** Russian UI copy kept per feature area, so parallel work does not share one file. */
export const featureRu: Readonly<Record<string, string>> = {
  ...acpRu,
  ...boardRu,
  ...chatRu,
  ...chatPipelinesRu,
  ...classicRu,
  ...executorsRu,
  ...harnessesRu,
  ...pluginsRu,
  ...releaseRu,
  ...runsRu,
  ...sessionRu,
  ...teamRu,
  ...triggersRu,
};
