import Terminal from '@lucide/svelte/icons/terminal';
import FilePen from '@lucide/svelte/icons/file-pen';
import FileText from '@lucide/svelte/icons/file-text';
import Search from '@lucide/svelte/icons/search';
import Globe from '@lucide/svelte/icons/globe';
import Workflow from '@lucide/svelte/icons/workflow';
import Wrench from '@lucide/svelte/icons/wrench';
import Brain from '@lucide/svelte/icons/brain';
import type { ToolKind } from './toolKinds';

/** One icon per kind of activity, shared by a tool row and the header of a group. */
export const toolIcons: Record<ToolKind, typeof Terminal> = {
  thinking: Brain,
  command: Terminal,
  edit: FilePen,
  read: FileText,
  search: Search,
  web: Globe,
  agent: Workflow,
  tool: Wrench,
};
