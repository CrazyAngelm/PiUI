import { acpRu } from './acp';
import { attentionRu } from './attention';
import { boardRu } from './board';
import { branchRu } from './branch';
import { chatRu } from './chat';
import { chatPipelinesRu } from './chatPipelines';
import { classicRu } from './classic';
import { dictationRu } from './dictation';
import { executorsRu } from './executors';
import { fusionRu } from './fusion';
import { harnessesRu } from './harnesses';
import { interactiveRu } from './interactive';
import { linksRu } from './links';
import { macrosRu } from './macros';
import { marksRu } from './marks';
import { modelsRu } from './models';
import { nanoRu } from './nano';
import { pluginsRu } from './plugins';
import { releaseRu } from './release';
import { runsRu } from './runs';
import { sessionRu } from './session';
import { subpipelinesRu } from './subpipelines';
import { teamRu } from './team';
import { triggersRu } from './triggers';
import { workbenchRu } from './workbench';

/** Russian UI copy kept per feature area, so parallel work does not share one file. */
export const featureRu: Readonly<Record<string, string>> = {
  ...acpRu,
  ...attentionRu,
  ...boardRu,
  ...branchRu,
  ...chatRu,
  ...chatPipelinesRu,
  ...classicRu,
  ...dictationRu,
  ...executorsRu,
  ...fusionRu,
  ...harnessesRu,
  ...interactiveRu,
  ...linksRu,
  ...macrosRu,
  ...marksRu,
  ...modelsRu,
  ...nanoRu,
  ...pluginsRu,
  ...releaseRu,
  ...runsRu,
  ...sessionRu,
  ...subpipelinesRu,
  ...teamRu,
  ...triggersRu,
  ...workbenchRu,
};
