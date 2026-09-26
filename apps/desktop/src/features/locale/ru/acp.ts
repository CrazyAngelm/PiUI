/** Russian UI copy for ACP agents. Keys are the English source strings. */
export const acpRu: Readonly<Record<string, string>> = {
  // Generic ACP adapter manifest (src/harness-adapters/acp.ts).
  'ACP agent': 'ACP-агент',
  'The agent keeps its own permission, tool and MCP settings. PiUI answers its permission requests but cannot restrict its tools or files.':
    'Агент сам управляет своими разрешениями, инструментами и MCP. PiUI отвечает на его запросы разрешений, но не может ограничить его инструменты или файлы.',
  'Instructions are sent with the first message; the agent keeps its own system prompt.':
    'Инструкции отправляются с первым сообщением; агент сохраняет свой системный промпт.',
};
