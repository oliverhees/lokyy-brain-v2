// Local-model (Ollama) onboarding availability (LBV2-19).
// A guarded (hosted) vault disables /api/system and /api/ollama/*; the server
// says so via GET /api/health → features.localModels.

export const LOCAL_MODELS_DISABLED_MESSAGE = 'Local models are disabled on this server — choose a cloud provider';

export interface HealthFeatures {
  ok?: boolean;
  features?: { capture?: boolean; localModels?: boolean };
}

/** Available unless the server explicitly reports otherwise (older servers send no flag). */
export function localModelsAvailable(health: HealthFeatures | null | undefined): boolean {
  return health?.features?.localModels !== false;
}

/** apiGet throws `API <status>: <body>`; a 404 means the route does not exist on this server. */
export function isNotFoundError(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith('API 404');
}
