import { describe, it, expect } from 'vitest';
import { localModelsAvailable, isNotFoundError } from './local-setup';

describe('local-setup helpers (LBV2-19)', () => {
  it('local models are available unless the server says otherwise', () => {
    expect(localModelsAvailable({ ok: true, features: { capture: true, localModels: false } })).toBe(false);
    expect(localModelsAvailable({ ok: true, features: { capture: true, localModels: true } })).toBe(true);
    expect(localModelsAvailable({ ok: true, features: { capture: true } })).toBe(true);
    expect(localModelsAvailable(null)).toBe(true);
  });

  it('recognises a 404 from apiGet', () => {
    expect(isNotFoundError(new Error('API 404: {"error":"Not found"}'))).toBe(true);
    expect(isNotFoundError(new Error('API 500: boom'))).toBe(false);
    expect(isNotFoundError('API 404')).toBe(false);
  });
});
