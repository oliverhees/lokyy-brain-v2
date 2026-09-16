// apps/mcp/src/prompts/index.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as dailyDigest from './daily-digest.js';
import * as brainstorm from './brainstorm.js';
import * as audit from './audit.js';
import * as connect from './connect.js';
import * as explain from './explain.js';
import * as quiz from './quiz.js';
import * as write from './write.js';
import { isToolAllowed, type AccessProfile } from '../access.js';

/** Tools each prompt tells the model to call; a prompt is hidden when any of them is not allowed. */
const PROMPT_TOOLS: Readonly<Record<string, readonly string[]>> = {
  'daily-digest': ['list_recent'],
  brainstorm: ['search_wiki', 'find_related', 'read_wiki_page'],
  audit: ['run_wiki_health'],
  connect: ['list_recent', 'find_related'],
  explain: ['read_wiki_page'],
  quiz: ['list_recent'],
  write: ['search_wiki', 'semantic_search', 'find_related', 'read_wiki_page'],
};

export function registerPrompts(server: Server, profile: AccessProfile = 'full'): void {
  const allPrompts = [
    dailyDigest.definition,
    brainstorm.definition,
    audit.definition,
    connect.definition,
    explain.definition,
    quiz.definition,
    write.definition,
  ];
  // Fail closed: a prompt missing from PROMPT_TOOLS is only offered to full sessions.
  const prompts = allPrompts.filter((p) => {
    const tools = PROMPT_TOOLS[p.name];
    return profile === 'full' || (tools !== undefined && tools.every((t) => isToolAllowed(profile, t)));
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, string>;
    if (!prompts.some((p) => p.name === name)) throw new Error(`Unknown prompt: ${name}`);

    const renderText = (): string => {
      switch (name) {
        case 'daily-digest': return dailyDigest.template;
        case 'brainstorm': return brainstorm.template(args['topic'] ?? '');
        case 'audit': return audit.template;
        case 'connect': return connect.template;
        case 'explain': return explain.template(args['slug'] ?? '');
        case 'quiz': return quiz.template;
        case 'write': return write.template(args['topic'] ?? '');
        default: throw new Error(`Unknown prompt: ${name}`);
      }
    };

    return {
      description: prompts.find((p) => p.name === name)?.description,
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: renderText() },
        },
      ],
    };
  });
}
