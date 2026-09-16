import { describe, it, expect } from 'vitest';
import { MASKED_SECRET, editedKey, keyAfterDestinationChange, modelSwitchPayload } from './config-form';
import { apiErrorMessage } from './api';

describe('config form helpers (LBV2-9 QA)', () => {
  it('the chat model switch sends only the fields it changes (no masked secrets)', () => {
    expect(modelSwitchPayload('llama3')).toEqual({ provider: 'ollama', model: 'llama3' });
  });

  it('clears a masked key when provider or endpoint changes, keeps a typed key', () => {
    expect(MASKED_SECRET).toBe('********');
    expect(keyAfterDestinationChange(MASKED_SECRET)).toBe('');
    expect(keyAfterDestinationChange('********abc')).toBe('');
    expect(keyAfterDestinationChange('sk-typed')).toBe('sk-typed');
    expect(keyAfterDestinationChange('')).toBe('');
  });
});

describe('editedKey', () => {
  it('drops mask characters when the user edits a masked field', () => {
    expect(editedKey(MASKED_SECRET, '********abc')).toBe('abc');
    expect(editedKey(MASKED_SECRET, '*******')).toBe('');
    expect(editedKey(MASKED_SECRET, 'sk-pasted')).toBe('sk-pasted');
    expect(editedKey('sk-a', 'sk-ab')).toBe('sk-ab');
    expect(editedKey(MASKED_SECRET, MASKED_SECRET)).toBe(MASKED_SECRET);
  });
});

describe('apiErrorMessage (LBV2-9 QA 6)', () => {
  it('surfaces the server error field instead of raw JSON', () => {
    expect(apiErrorMessage(400, '{"ok":false,"error":"Re-enter the API key when changing provider or endpoint"}'))
      .toBe('Re-enter the API key when changing provider or endpoint');
    expect(apiErrorMessage(403, '{"error":"Forbidden"}')).toBe('Forbidden (403)');
  });

  it('falls back to the status for non-JSON or empty bodies', () => {
    expect(apiErrorMessage(500, '<html>oops</html>')).toBe('API 500');
    expect(apiErrorMessage(502, '')).toBe('API 502');
    expect(apiErrorMessage(400, '{"nope":1}')).toBe('API 400');
  });
});
