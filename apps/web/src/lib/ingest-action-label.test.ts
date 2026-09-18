import { describe, it, expect } from 'vitest';
import { ingestActionLabel } from './ingest-action-label';

// LBV2-32 QA: every plan action gets a readable label, never "?".
const call = (name: string, args: Record<string, unknown>) => ({ id: 'x', name, arguments: args });

describe('ingestActionLabel', () => {
  it.each([
    [call('create_concept', { name: 'Basel' }), 'Basel'],
    [call('append_to_concept', { concept_name: 'Roche', section: 'History' }), 'Roche'],
    [call('rewrite_concept', { concept_name: 'Roche' }), 'Roche'],
    [call('update_one_liner', { concept_name: 'Roche' }), 'Roche'],
    [call('update_note', { note_name: 'my-note' }), 'my-note'],
    [call('read_concept', { slug: 'basel' }), 'basel'],
    [call('propose_edit', { slug: 'basel', section_anchor: 'Economy' }), 'basel'],
    [call('add_to_index', { title: 'Basel', path: 'wiki/concepts/basel.md' }), 'Basel'],
    [call('add_to_index', { path: 'wiki/concepts/basel.md' }), 'wiki/concepts/basel.md'],
    [call('update_source_backlinks', { raw_id: 'ab12cd', linked_concepts: ['basel', 'roche'] }), 'basel, roche'],
    [call('update_source_backlinks', { raw_id: 'ab12cd', linked_concepts: [] }), 'source ab12cd'],
    [call('link', { from: 'basel', to: 'roche', type: 'cites' }), 'basel → roche (cites)'],
    [call('link', { from: 'basel', to: 'roche' }), 'basel → roche'],
    [call('flag_contradiction', { slug_a: 'a', slug_b: 'b' }), 'a ↔ b'],
    [call('merge', { keep: 'a', absorb: 'b' }), 'b into a'],
    [call('skip', { reason: 'empty source' }), 'empty source'],
    [call('append_to_daily_note', { section: 'Log' }), 'daily note · Log'],
    [call('append_to_daily_note', {}), 'daily note'],
  ])('%j → %s', (c, label) => {
    expect(ingestActionLabel(c)).toBe(label);
  });

  it('never returns "?" for unknown or empty arguments', () => {
    expect(ingestActionLabel(call('something_new', {}))).toBe('');
    expect(ingestActionLabel(call('link', {}))).toBe('');
    expect(ingestActionLabel(call('update_source_backlinks', {}))).toBe('');
  });
});
