import { promises as fs } from 'node:fs';
import { guardLlmFetch } from '@mindbase/core';

export async function transcribeAudio(audioPath: string, apiKey: string): Promise<string> {
  const form = new FormData();
  const buf = await fs.readFile(audioPath);
  const blob = new Blob([buf], { type: 'audio/mpeg' });
  form.append('file', blob, 'audio.m4a');
  form.append('model', 'whisper-1');
  form.append('response_format', 'text');

  // Carries the API key: same host allow-list as the LLM adapters (LBV2-19).
  const res = await guardLlmFetch(fetch)('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Whisper failed: ${res.status} ${await res.text()}`);
  return (await res.text()).trim();
}
