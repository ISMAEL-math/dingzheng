import test from 'node:test';
import assert from 'node:assert/strict';
import { enabledLanguageChatModels, isLanguageChatModel, contextWindowFor, shortModelName } from '../public/chat-models.mjs';

test('keeps general language models, including named Codex families', () => {
  for (const model of ['GPT-6.1-Sol', 'GPT-6-Luna', 'GPT-6-Astra', 'deepseek-ai/DeepSeek-V4-Flash', 'Qwen/Qwen3-32B']) {
    assert.equal(isLanguageChatModel(model), true, model);
  }
});

test('filters image, embedding, audio, and reranking task models from the chat picker', () => {
  for (const model of ['Qwen/Qwen3-VL-32B-Instruct', 'Qwen/Qwen3-Embedding-8B', 'black-forest-labs/FLUX.1-schnell', 'BAAI/bge-reranker-v2', 'openai/whisper-large-v3', 'deepseek-ai/DeepSeek-OCR']) {
    assert.equal(isLanguageChatModel(model), false, model);
  }
});

test('uses task metadata to omit image-only catalog entries', () => {
  assert.equal(isLanguageChatModel({ id: 'vendor/model-x', task: 'image-to-text' }), false);
  assert.equal(isLanguageChatModel({ id: 'vendor/model-y', task: 'text-generation' }), true);
});

test('limits the home chat picker to enabled language models', () => {
  const catalog = ['GPT-6-Luna', 'Qwen/Qwen3-VL-32B-Instruct', 'Qwen/Qwen3-Embedding-8B', 'deepseek-ai/DeepSeek-V4-Flash'];
  assert.deepEqual(enabledLanguageChatModels(catalog, ['GPT-6-Luna', 'Qwen/Qwen3-VL-32B-Instruct']), ['GPT-6-Luna']);
});

test('keeps selected model metadata while removing duplicates and disabled entries', () => {
  const catalog = [{ id: 'vendor/model-a', name: 'Model A' }, { id: 'vendor/model-b', name: 'Model B' }, { id: 'vendor/model-a', name: 'Duplicate' }];
  assert.deepEqual(enabledLanguageChatModels(catalog, ['vendor/model-a']), [{ id: 'vendor/model-a', name: 'Model A' }]);
});

test('estimates context windows by model family with a common default', () => {
  assert.equal(contextWindowFor('deepseek-ai/DeepSeek-V4-Flash'), 128000);
  assert.equal(contextWindowFor('Qwen/Qwen3-32B'), 131072);
  assert.equal(contextWindowFor('gpt-5.1-codex'), 400000);
  assert.equal(contextWindowFor('unknown-vendor/model-x'), 128000);
  assert.equal(contextWindowFor(''), 128000);
});

test('shortens model names for the picker label', () => {
  assert.equal(shortModelName('deepseek-ai/DeepSeek-V4-Flash'), 'DeepSeek-V4-Flash');
  assert.equal(shortModelName('Qwen/Qwen3-32B-Instruct'), 'Qwen3-32B');
  assert.equal(shortModelName('gpt-5.1-codex'), 'gpt-5.1-codex');
  assert.equal(shortModelName(''), '');
});
