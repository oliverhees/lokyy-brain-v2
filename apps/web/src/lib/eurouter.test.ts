import { describe, it, expect } from 'vitest';
import { EUROUTER_BASE_URL, isEurouterUrl, modelChipLabel } from './eurouter';

describe('isEurouterUrl (LBV2-30)', () => {
  it.each([EUROUTER_BASE_URL, 'https://API.eurouter.ai/api/v1/', 'https://api.eurouter.ai/api/v1/chat/completions'])('accepts %s', (u) => {
    expect(isEurouterUrl(u)).toBe(true);
  });
  it.each(['', 'http://api.eurouter.ai/api/v1', 'https://api.openai.com', 'https://eurouter.ai/api/v1', 'https://api.eurouter.ai.evil.example', 'nope'])('rejects %s', (u) => {
    expect(isEurouterUrl(u)).toBe(false);
  });
});

describe('modelChipLabel (LBV2-30)', () => {
  it('shows the route name for a route, else the model, else unconfigured', () => {
    expect(modelChipLabel('', 'r', 'EU Compliance')).toBe('EU Compliance');
    expect(modelChipLabel('gpt-4o', 'r', 'EU Compliance')).toBe('EU Compliance');
    expect(modelChipLabel('', 'r', undefined)).toBe('EUrouter route');
    expect(modelChipLabel('gpt-4o', undefined, undefined)).toBe('gpt-4o');
    expect(modelChipLabel('', undefined, undefined)).toBe('unconfigured');
  });
});
