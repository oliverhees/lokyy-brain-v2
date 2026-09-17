import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ollamaRoutes } from '../ollama.js';
import { transcribeAudio } from '../../lib/audio.js';

// Audit LBV2-19 L1/L2: the remaining provider calls outside the adapters.
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function appWith(env: NodeJS.ProcessEnv): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api', ollamaRoutes(env));
  return app;
}

describe('Ollama onboarding routes (LBV2-19 L2)', () => {
  it('are disabled (404) in guarded mode and never probe Ollama', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const app = appWith({ VAULT_PROXY_SECRET: 'x'.repeat(32), VAULT_LLM_ALLOWED_HOSTS: 'localhost:11434' });
    expect((await request(app).get('/api/system')).status).toBe(404);
    expect((await request(app).get('/api/ollama/status')).status).toBe(404);
    expect((await request(app).post('/api/ollama/pull').send({ model: 'llama3.2' })).status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('are disabled when only VAULT_REQUIRE_PROXY_SECRET is set', async () => {
    expect((await request(appWith({ VAULT_REQUIRE_PROXY_SECRET: '1' })).get('/api/system')).status).toBe(404);
  });

  it('stay available in local mode', async () => {
    const res = await request(appWith({})).get('/api/system');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('recommendations');
  });
});

describe('Whisper transcription (LBV2-19 L1)', () => {
  it('is refused when api.openai.com is not listed, without a request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('VAULT_PROXY_SECRET', 'x'.repeat(32));
    vi.stubEnv('VAULT_LLM_ALLOWED_HOSTS', 'api.eurouter.ai');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const dir = await mkdtemp(join(tmpdir(), 'audio-test-'));
    try {
      const file = join(dir, 'a.m4a');
      await writeFile(file, 'fake');
      await expect(transcribeAudio(file, 'sk-test')).rejects.toThrow('LLM endpoint not allowed');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('calls OpenAI when api.openai.com is listed', async () => {
    vi.stubEnv('VAULT_PROXY_SECRET', 'x'.repeat(32));
    vi.stubEnv('VAULT_LLM_ALLOWED_HOSTS', 'api.openai.com');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(' hello '));
    const dir = await mkdtemp(join(tmpdir(), 'audio-test-'));
    try {
      const file = join(dir, 'a.m4a');
      await writeFile(file, 'fake');
      await expect(transcribeAudio(file, 'sk-test')).resolves.toBe('hello');
      expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://api.openai.com/v1/audio/transcriptions');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
