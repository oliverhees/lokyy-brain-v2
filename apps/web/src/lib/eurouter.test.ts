import { describe, it, expect } from 'vitest';
import { EUROUTER_BASE_URL, isEurouterUrl } from './eurouter';

describe('isEurouterUrl (LBV2-30)', () => {
  it.each([EUROUTER_BASE_URL, 'https://API.eurouter.ai/api/v1/', 'https://api.eurouter.ai/api/v1/chat/completions'])('accepts %s', (u) => {
    expect(isEurouterUrl(u)).toBe(true);
  });
  it.each(['', 'https://api.openai.com', 'https://eurouter.ai/api/v1', 'https://api.eurouter.ai.evil.example', 'nope'])('rejects %s', (u) => {
    expect(isEurouterUrl(u)).toBe(false);
  });
});
