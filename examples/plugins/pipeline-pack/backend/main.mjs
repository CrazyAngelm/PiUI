import { PluginError, startPluginBackend } from './piui-plugin-backend.mjs';
import { transformJson } from './transform.mjs';

// The pipeline-pack example backend: PiUI starts it when a pipeline reaches a
// JSON transform node, sends the step's inputs, dependency results and node
// configuration (`node/run`), and records the returned object as the step's
// result, checked against the node's result fields.
startPluginBackend({
  nodes: {
    'json-transform': (request) => {
      try {
        return transformJson(request);
      } catch (error) {
        throw new PluginError(error instanceof Error ? error.message : String(error));
      }
    },
  },
});
