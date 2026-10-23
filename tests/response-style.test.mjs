import test from 'node:test';
import assert from 'node:assert/strict';
import { GLOBAL_STYLE_PROMPT, withGlobalStyle } from '../public/response-style.js';

test('global style preserves task constraints and request fields without mutating the input', () => {
  const body = { model: 'any-model', response_format: { type: 'json_object' }, tools: [{ type: 'function' }], messages: [{ role: 'system', content: '只返回 JSON，不得改写题目。' }, { role: 'user', content: '原始题目' }] };
  const original = structuredClone(body), result = withGlobalStyle(body);
  assert.deepEqual(body, original);
  assert.equal(result.messages[0].content, `${GLOBAL_STYLE_PROMPT}\n\n只返回 JSON，不得改写题目。`);
  assert.deepEqual(result.messages[1], original.messages[1]);
  assert.deepEqual(result.tools, body.tools);
  assert.deepEqual(result.response_format, body.response_format);
});

test('repeated wrapping for tool rounds does not duplicate the style prompt', () => {
  const once = withGlobalStyle({ messages: [{ role: 'user', content: '解释概念' }] });
  assert.equal(once.messages[0].role, 'system');
  assert.equal(withGlobalStyle(once), once);
  assert.equal(withGlobalStyle({ input: 'other API' }).input, 'other API');
});
