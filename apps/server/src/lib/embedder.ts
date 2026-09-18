/**
 * Server-side embeddings wrapper. Wraps the BGE-M3 model from @xenova/transformers.
 * This module MUST NOT be imported by the web bundle.
 * Lives here (apps/server) so Vite never sees it.
 *
 * With MINDBASE_EMBED_URL + MINDBASE_EMBED_TOKEN (hosted vaults, LBV2-26) embeddings come from the
 * shared embedding service and the model is never loaded in this process; errors are thrown (and
 * logged without text content), never answered by loading the model locally.
 */

import type { FeatureExtractionPipeline } from '@xenova/transformers';
import { EMBED_MAX_CHARS, EMBED_MAX_TOKENS, remoteEmbedderFromEnv, type RemoteEmbedder } from '@mindbase/core';
import { applyModelPolicy } from './transformers-offline';

let extractor: FeatureExtractionPipeline | null = null;
let remote: { key: string; embedder: RemoteEmbedder | null } | null = null;

/** Read on every call (cheap) so a misconfiguration surfaces as an error on first use, not at import. */
function remoteEmbedder(): RemoteEmbedder | null {
  const key = `${process.env['MINDBASE_EMBED_URL'] ?? ''}\n${process.env['MINDBASE_EMBED_TOKEN'] ?? ''}`;
  if (remote?.key !== key) remote = { key, embedder: remoteEmbedderFromEnv(process.env) };
  return remote.embedder;
}

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor;
  const { pipeline, env } = await import('@xenova/transformers');
  applyModelPolicy(env);
  extractor = (await pipeline('feature-extraction', 'Xenova/bge-m3')) as FeatureExtractionPipeline;
  // Same token cap as the shared embedding service (vectors stay interchangeable, bounded memory)
  (extractor as unknown as { tokenizer: { model_max_length: number } }).tokenizer.model_max_length = EMBED_MAX_TOKENS;
  return extractor;
}

export async function embed(text: string): Promise<number[]> {
  const service = remoteEmbedder();
  if (service) {
    try {
      return await service.embed(text);
    } catch (e) {
      console.warn(`[embedder] ${(e as Error).message}`);
      throw e;
    }
  }
  const fx = await getExtractor();
  const result = await fx(text.slice(0, EMBED_MAX_CHARS), { pooling: 'mean', normalize: true });
  return Array.from(result.data as Float32Array);
}

export function unloadExtractor(): void {
  extractor = null;
}
