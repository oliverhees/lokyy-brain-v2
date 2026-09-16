import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileStore } from './file_store';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('FileStore', () => {
  let store: FileStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `atlas-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });
    store = new FileStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('path containment (LBV2-11)', () => {
    const escapes = ['../secret.md', '../../etc/passwd', 'wiki/../../secret.md', 'wiki/notes/../../../secret.md', '..'];

    beforeEach(async () => {
      await fs.writeFile(path.join(tmpDir, '..', 'secret.md'), 'TOP SECRET');
    });
    afterEach(async () => {
      await fs.rm(path.join(tmpDir, '..', 'secret.md'), { force: true });
    });

    it.each(escapes)('rejects reads outside the root: %s', async (p) => {
      await expect(store.readText(p)).rejects.toThrow(/outside/);
      await expect(store.readBinary(p)).rejects.toThrow(/outside/);
      expect(await store.exists(p)).toBe(false);
      expect(await store.listDir(p)).toEqual([]);
    });

    it.each(escapes)('rejects writes and deletes outside the root: %s', async (p) => {
      await expect(store.writeText(p, 'x')).rejects.toThrow(/outside/);
      await expect(store.writeBinary(p, new Uint8Array([1]))).rejects.toThrow(/outside/);
      await expect(store.remove(p)).rejects.toThrow(/outside/);
      expect(await fs.readFile(path.join(tmpDir, '..', 'secret.md'), 'utf-8')).toBe('TOP SECRET');
    });

    it('keeps leading slashes relative to the root (never reads the host path)', async () => {
      await store.writeText('/etc/passwd', 'inside the store');
      expect(await fs.readFile(path.join(tmpDir, 'etc', 'passwd'), 'utf-8')).toBe('inside the store');
    });

    it('still allows dot segments that stay inside the root', async () => {
      await store.writeText('wiki/notes/../hello.md', 'inside');
      expect(await store.readText('wiki/hello.md')).toBe('inside');
    });

    it('allows the root itself for listing', async () => {
      await store.writeText('a.md', 'x');
      expect((await store.listDir('')).map((e) => e.name)).toContain('a.md');
    });
  });

  it('writes and reads a text file', async () => {
    await store.writeText('hello.md', '# Hello');
    expect(await store.readText('hello.md')).toBe('# Hello');
  });

  it('creates parent directories on write', async () => {
    await store.writeText('wiki/concepts/rag.md', 'Content');
    expect(await store.readText('wiki/concepts/rag.md')).toBe('Content');
  });

  it('overwrites existing files', async () => {
    await store.writeText('a.md', 'first');
    await store.writeText('a.md', 'second');
    expect(await store.readText('a.md')).toBe('second');
  });

  it('exists returns true for files and directories', async () => {
    await store.writeText('dir/file.md', 'x');
    expect(await store.exists('dir/file.md')).toBe(true);
    expect(await store.exists('dir')).toBe(true);
    expect(await store.exists('missing')).toBe(false);
  });

  it('readJSON and writeJSON roundtrip', async () => {
    await store.writeJSON('meta.json', { a: 1, b: 'two' });
    expect(await store.readJSON('meta.json')).toEqual({ a: 1, b: 'two' });
  });

  it('listDir returns entries', async () => {
    await store.writeText('dir/a.md', 'a');
    await store.writeText('dir/b.md', 'b');
    await store.writeText('dir/sub/c.md', 'c');
    const entries = await store.listDir('dir');
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['a.md', 'b.md', 'sub']);
  });

  it('listDir distinguishes file and directory kind', async () => {
    await store.writeText('dir/a.md', 'a');
    await store.writeText('dir/sub/c.md', 'c');
    const entries = await store.listDir('dir');
    expect(entries.find((e) => e.name === 'a.md')?.kind).toBe('file');
    expect(entries.find((e) => e.name === 'sub')?.kind).toBe('directory');
  });

  it('listDir returns empty for nonexistent directory', async () => {
    expect(await store.listDir('nowhere')).toEqual([]);
  });

  it('remove deletes a file', async () => {
    await store.writeText('del.md', 'x');
    await store.remove('del.md');
    expect(await store.exists('del.md')).toBe(false);
  });

  it('readText throws on missing file', async () => {
    await expect(store.readText('missing.md')).rejects.toThrow();
  });

  it('files are real on disk', async () => {
    await store.writeText('wiki/test.md', 'hello disk');
    const content = await fs.readFile(path.join(tmpDir, 'wiki', 'test.md'), 'utf-8');
    expect(content).toBe('hello disk');
  });
});
