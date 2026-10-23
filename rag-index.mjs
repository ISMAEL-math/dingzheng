import { createHash } from 'node:crypto';
import { OpenAIEmbedding } from '@llamaindex/openai';
import { SimpleVectorStore, TextNode, VectorStoreQueryMode } from 'llamaindex';

const stores = new Map();
const MAX_CACHED_INDEXES = 8;

export async function embedTexts({ model, apiKey, baseURL, texts, signal }) {
  if (!Array.isArray(texts) || texts.some(text => typeof text !== 'string' || !text.trim())) {
    throw new Error('嵌入文本无效');
  }
  signal?.throwIfAborted();
  const requestFetch = signal ? (input, init = {}) => {
    const signals = [init.signal, signal].filter(Boolean);
    return fetch(input, { ...init, ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) });
  } : undefined;
  const embedding = new OpenAIEmbedding({
    model,
    apiKey,
    baseURL,
    maxRetries: 2,
    timeout: 60_000,
    ...(requestFetch ? { additionalSessionOptions: { fetch: requestFetch } } : {}),
  });
  const vectors = await embedding.getTextEmbeddings(texts);
  signal?.throwIfAborted();
  return vectors;
}

export async function rankVectors({ items, queryEmbedding, topK = 40 }) {
  if (!Array.isArray(items) || !Array.isArray(queryEmbedding) || !queryEmbedding.length) return [];
  const usable = items.filter(item => typeof item.id === 'string' && Array.isArray(item.embedding)
    && item.embedding.length === queryEmbedding.length && item.embedding.every(Number.isFinite));
  if (!usable.length) return [];

  const fingerprint = createHash('sha256')
    .update(JSON.stringify(usable.map(item => [item.id, item.embedding])))
    .digest('hex');
  let store = stores.get(fingerprint);
  if (!store) {
    store = new SimpleVectorStore();
    await store.add(usable.map(item => new TextNode({
      id_: item.id,
      text: item.id,
      embedding: item.embedding,
    })));
    stores.set(fingerprint, store);
    while (stores.size > MAX_CACHED_INDEXES) stores.delete(stores.keys().next().value);
  } else {
    stores.delete(fingerprint);
    stores.set(fingerprint, store);
  }

  const result = await store.query({
    queryEmbedding,
    similarityTopK: Math.min(Math.max(1, topK), usable.length),
    mode: VectorStoreQueryMode.DEFAULT,
  });
  return (result.ids || []).map((id, index) => ({ id, similarity: result.similarities[index] ?? 0 }));
}
