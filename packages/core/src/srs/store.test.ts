import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from './store';

let tmpDir: string;
let store: CardStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'srs-test-'));
  store = new CardStore(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('CardStore — basic CRUD', () => {
  it('creates a card and lists it', async () => {
    const card = await store.create({ question: 'What is X?', answer: 'It is Y.' });
    expect(card.id).toBeTruthy();
    expect(card.question).toBe('What is X?');

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(card.id);
  });

  it('persists across instances', async () => {
    const card = await store.create({ question: 'Q', answer: 'A' });

    // New instance reading same dir
    const store2 = new CardStore(tmpDir);
    const list = await store2.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(card.id);
  });

  it('delete removes the card', async () => {
    const card = await store.create({ question: 'Q', answer: 'A' });
    await store.delete(card.id);
    const list = await store.list();
    expect(list).toHaveLength(0);
  });

  it('update patches the card', async () => {
    const card = await store.create({ question: 'Q', answer: 'A' });
    const updated = await store.update(card.id, { question: 'Updated Q' });
    expect(updated.question).toBe('Updated Q');
    expect(updated.answer).toBe('A');
  });
});

describe('CardStore — findDue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // LBV2-14: the old test sampled `now` BEFORE creating the card; whenever the
  // clock ticked in between, due_at (= creation time) was 1 ms after `now` and the
  // card was correctly reported as not yet due (~1 in 3 runs). The clock is pinned.
  it('a card created after the cutoff is not due at that cutoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const cutoff = new Date();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.001Z'));
    const card = await store.create({ question: 'Q', answer: 'A' });
    expect((await store.findDue(cutoff)).cards.some(c => c.id === card.id)).toBe(false);
    expect((await store.findDue(new Date())).cards.some(c => c.id === card.id)).toBe(true);
  });

  it('filters cards by due_at', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(t0);

    const answered = await store.create({ question: 'Answered card', answer: 'A' });
    await store.answer(answered.id, 'good', t0);
    await store.answer(answered.id, 'good', t0); // second 'good' -> interval 6 days
    const dueCard = await store.create({ question: 'Still due', answer: 'A' });

    const due = await store.findDue(t0);
    expect(due.cards.map(c => c.id)).toEqual([dueCard.id]);
    expect(due.total).toBe(1);

    expect((await store.findDue(new Date(t0.getTime() - 10 * 60 * 1000))).total).toBe(0);
    expect((await store.findDue(new Date(t0.getTime() + 10 * 24 * 60 * 60 * 1000))).total).toBe(2);
  });

  it('excludes archived cards from due', async () => {
    const card = await store.create({ question: 'Q', answer: 'A' });
    await store.update(card.id, { archived: true });

    const due = await store.findDue(new Date(Date.now() + 10000));
    expect(due.cards.some(c => c.id === card.id)).toBe(false);
  });
});

describe('CardStore — stats', () => {
  it('counts mastered, learning, archived, due correctly', async () => {
    // Create learning card (reps < 5)
    await store.create({ question: 'Learning', answer: 'A' });

    // Create a second learning card
    await store.create({ question: 'Learning2', answer: 'B' });

    // Archive one
    const card3 = await store.create({ question: 'Archived', answer: 'C' });
    await store.update(card3.id, { archived: true });

    // Use a future now so newly created cards (due_at = creation time) are due
    const futureNow = new Date(Date.now() + 60 * 1000);
    const stats = await store.stats(futureNow);
    expect(stats.total).toBe(3);
    expect(stats.archived).toBe(1);
    expect(stats.learning).toBeGreaterThanOrEqual(1); // card1, card2
    expect(stats.due).toBeGreaterThanOrEqual(1); // newly created cards are due
  });

  it('counts by_tag correctly', async () => {
    await store.create({ question: 'Q1', answer: 'A', tags: ['ml', 'ai'] });
    await store.create({ question: 'Q2', answer: 'A', tags: ['ml'] });

    const stats = await store.stats();
    expect(stats.by_tag['ml']).toBe(2);
    expect(stats.by_tag['ai']).toBe(1);
  });
});

describe('CardStore — archive', () => {
  it('sets archived_at when archiving', async () => {
    const card = await store.create({ question: 'Q', answer: 'A' });
    expect(card.archived_at).toBeUndefined();

    const updated = await store.update(card.id, { archived: true });
    expect(updated.archived).toBe(true);
    expect(updated.archived_at).toBeTruthy();
  });

  it('clears archived_at when unarchiving', async () => {
    const card = await store.create({ question: 'Q', answer: 'A' });
    await store.update(card.id, { archived: true });
    const unarchived = await store.update(card.id, { archived: false });
    expect(unarchived.archived).toBe(false);
    expect(unarchived.archived_at).toBeUndefined();
  });

  it('list() excludes archived by default, includes when flagged', async () => {
    const card = await store.create({ question: 'Q', answer: 'A' });
    await store.update(card.id, { archived: true });

    const defaultList = await store.list();
    expect(defaultList).toHaveLength(0);

    const withArchived = await store.list({ include_archived: true });
    expect(withArchived).toHaveLength(1);
  });
});

describe('CardStore — countCreatedSince', () => {
  it('counts only cards created after the since date', async () => {
    const before = new Date(Date.now() - 1000);
    await store.create({ question: 'Q1', answer: 'A' });
    await store.create({ question: 'Q2', answer: 'A' });

    const count = await store.countCreatedSince(before);
    expect(count).toBe(2);

    const future = new Date(Date.now() + 1000);
    const countFuture = await store.countCreatedSince(future);
    expect(countFuture).toBe(0);
  });
});

describe('CardStore — findBySource', () => {
  it('filters by source_slug', async () => {
    await store.create({ question: 'Q1', answer: 'A', source_slug: 'rag-systems' });
    await store.create({ question: 'Q2', answer: 'A', source_slug: 'other-page' });

    const result = await store.findBySource('rag-systems');
    expect(result).toHaveLength(1);
    expect(result[0]!.question).toBe('Q1');
  });

  it('includes archived cards in findBySource', async () => {
    const card = await store.create({ question: 'Q', answer: 'A', source_slug: 'my-page' });
    await store.update(card.id, { archived: true });

    const result = await store.findBySource('my-page');
    expect(result).toHaveLength(1);
  });
});
