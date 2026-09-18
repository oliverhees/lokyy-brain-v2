import type { LLMAdapter } from './types';
import type { ToolDefinition } from '../types';

/** Minimal tool the probe asks the model to call. */
export const TOOL_PROBE_TOOL: ToolDefinition = {
  name: 'record_value',
  description: 'Records a value. Call this tool; do not answer in text.',
  parameters: {
    type: 'object',
    properties: { value: { type: 'string', description: 'The value to record.' } },
    required: ['value'],
  },
};

export type ToolProbeResult =
  | { status: 'supported' }
  | { status: 'unsupported' }
  | { status: 'unknown'; error: string };

/**
 * One tiny chat request with a single tool, to learn whether the configured
 * model/route returns tool calls — ingest (compile) cannot write pages without
 * them (LBV2-32). `unknown` means the probe itself failed.
 */
export async function probeToolCalling(adapter: LLMAdapter, model: string): Promise<ToolProbeResult> {
  try {
    for await (const chunk of adapter.chat({
      model,
      messages: [{ role: 'user', content: `Call the ${TOOL_PROBE_TOOL.name} tool with value "ok".` }],
      tools: [TOOL_PROBE_TOOL],
      // Headroom for reasoning models that think before emitting the call.
      max_tokens: 256,
    })) {
      if (chunk.kind === 'tool_call') return { status: 'supported' };
      if (chunk.kind === 'error') return { status: 'unknown', error: chunk.error };
    }
    return { status: 'unsupported' };
  } catch (e) {
    return { status: 'unknown', error: (e as Error).message };
  }
}

/** Connection-test warning when an EUrouter route answers but never calls tools. */
export const ROUTE_NO_TOOLS_WARNING =
  "Connected, but the selected route's model doesn't support tool calls needed for ingest — " +
  'choose a route with tool-capable models.';
