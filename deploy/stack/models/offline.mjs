// Loaded in every vault via NODE_OPTIONS=--import=/lokyy/offline.mjs (LBV2-24, review item 7).
// Makes @xenova/transformers use only the verified local model cache: whenever its env module is
// loaded, `env.allowRemoteModels = false` is appended, so a model file missing from /models is an
// error instead of a download from Hugging Face. Lazy: nothing is imported until the vault itself
// loads transformers (embeddings), and the vault code stays unchanged.
import { register } from 'node:module';

const hooks = `
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (/\\/@xenova\\/transformers\\/src\\/env\\.js$/.test(url)) {
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
    return { ...result, source: source + '\\nenv.allowRemoteModels = false;\\n', shortCircuit: true };
  }
  return result;
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);
