// Client-side helpers for editing server config without echoing masked
// secrets back to a new destination. Mirrors apps/server/src/lib/config-secrets.ts
// (web may not import server/core values).

/** What GET /api/config returns in place of a stored secret. */
export const MASKED_SECRET = '********';

/** Body for the chat model switch: only the fields that change, so no masked secrets travel. */
export function modelSwitchPayload(model: string): { provider: 'ollama'; model: string } {
  return { provider: 'ollama', model };
}

/**
 * When provider or endpoint changes, a masked (or mask-derived) key is not a
 * usable key for the new destination: clear it so the user enters a real one.
 */
/** Editing a field that shows the mask: the mask characters are not part of the new key. */
export function editedKey(previous: string, next: string): string {
  if (previous !== MASKED_SECRET || next === MASKED_SECRET) return next;
  return next.replace(/\*/g, '');
}

export function keyAfterDestinationChange(apiKey: string): string {
  return apiKey.includes(MASKED_SECRET) ? '' : apiKey;
}
