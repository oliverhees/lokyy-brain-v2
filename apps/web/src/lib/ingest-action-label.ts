import type { ToolCall } from '@mindbase/core';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Human-readable target of a planned compile action for the ingest review list
 * (LBV2-32 QA: add_to_index / backlinks showed "?"). Empty when nothing useful is known.
 */
export function ingestActionLabel(call: Pick<ToolCall, 'name' | 'arguments'>): string {
  const a = (call.arguments ?? {}) as Record<string, unknown>;
  switch (call.name) {
    case 'add_to_index':
      return str(a['title']) || str(a['path']);
    case 'update_source_backlinks': {
      const linked = Array.isArray(a['linked_concepts']) ? a['linked_concepts'].filter((x): x is string => typeof x === 'string') : [];
      if (linked.length > 0) return linked.join(', ');
      return str(a['raw_id']) ? `source ${str(a['raw_id'])}` : '';
    }
    case 'link': {
      if (!str(a['from']) || !str(a['to'])) return '';
      const type = str(a['type']);
      return `${str(a['from'])} → ${str(a['to'])}${type ? ` (${type})` : ''}`;
    }
    case 'flag_contradiction':
      return str(a['slug_a']) && str(a['slug_b']) ? `${str(a['slug_a'])} ↔ ${str(a['slug_b'])}` : '';
    case 'merge':
      return str(a['keep']) && str(a['absorb']) ? `${str(a['absorb'])} into ${str(a['keep'])}` : '';
    case 'skip':
      return str(a['reason']);
    case 'append_to_daily_note':
      return str(a['section']) ? `daily note · ${str(a['section'])}` : 'daily note';
    default:
      return str(a['name']) || str(a['concept_name']) || str(a['note_name']) || str(a['slug']);
  }
}
