import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bindings } from '../src/bindings.ts';

const opts = { idleMs: 1_000, lifetimeMs: 10_000, max: 3, maxPerKey: 3 };

test('a bound session matches only the same key hash and endpoint', () => {
  let now = 0;
  const b = new Bindings({ ...opts, now: () => now });
  b.bind('sid-1', 'hashA', 'anna');
  assert.equal(b.check('sid-1', 'hashA', 'anna'), true);
  assert.equal(b.check('sid-1', 'hashB', 'anna'), false, 'other key');
  assert.equal(b.check('sid-1', 'hashA', 'ben'), false, 'other endpoint');
  assert.equal(b.check('sid-unknown', 'hashA', 'anna'), false, 'unknown session');
});

test('idle timeout and absolute lifetime expire a binding', () => {
  let now = 0;
  const b = new Bindings({ ...opts, now: () => now });
  b.bind('idle', 'h', 'e');
  now = 999;
  assert.equal(b.check('idle', 'h', 'e'), true, 'use refreshes idle timer');
  now = 1_998;
  assert.equal(b.check('idle', 'h', 'e'), true);
  now = 3_000;
  assert.equal(b.check('idle', 'h', 'e'), false, 'idle > 1 s');

  now = 0;
  const c = new Bindings({ ...opts, now: () => now });
  c.bind('old', 'h', 'e');
  for (now = 900; now < 10_000; now += 900) assert.equal(c.check('old', 'h', 'e'), true);
  now = 10_001;
  assert.equal(c.check('old', 'h', 'e'), false, 'lifetime exceeded although active');
});

test('unbind removes, a key over its own cap evicts only its own oldest binding, sweep drops expired entries', () => {
  let now = 0;
  const b = new Bindings({ ...opts, max: 10, maxPerKey: 3, now: () => now });
  b.bind('other', 'hB', 'e');
  b.bind('s1', 'h', 'e'); b.bind('s2', 'h', 'e'); b.bind('s3', 'h', 'e');
  assert.equal(b.bind('s4', 'h', 'e'), true);
  assert.equal(b.size, 4);
  assert.equal(b.check('s1', 'h', 'e'), false, 'own oldest evicted');
  assert.equal(b.check('other', 'hB', 'e'), true, 'other key untouched');
  b.unbind('other');
  b.unbind('s4');
  assert.equal(b.check('s4', 'h', 'e'), false);
  now = 5_000;
  b.sweep();
  assert.equal(b.size, 0);
});

test('global cap fails closed for the new binding and never evicts other keys', () => {
  const b = new Bindings({ ...opts, max: 3, maxPerKey: 3 });
  b.bind('a1', 'hA', 'e'); b.bind('a2', 'hA', 'e'); b.bind('b1', 'hB', 'e');
  assert.equal(b.hasCapacity('hC'), false);
  assert.equal(b.bind('c1', 'hC', 'e'), false);
  assert.equal(b.check('c1', 'hC', 'e'), false);
  for (const [s, h] of [['a1', 'hA'], ['a2', 'hA'], ['b1', 'hB']]) assert.equal(b.check(s, h, 'e'), true);
  assert.equal(b.hasCapacity('hA'), true, 'a key with bindings may still rotate its own');
});

test('binding a session id twice never changes its owner', () => {
  const b = new Bindings(opts);
  b.bind('sid', 'owner', 'anna');
  b.bind('sid', 'attacker', 'anna');
  assert.equal(b.check('sid', 'owner', 'anna'), true);
  assert.equal(b.check('sid', 'attacker', 'anna'), false);
});
