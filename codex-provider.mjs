import { CodexError } from './codex-auth.mjs';

const OPENAI_API = 'https://api.openai.com/v1';
const NAMESPACE = 'dingzheng';
const MAX_SSE_PROBE_BYTES = 256 * 1024;
const MAX_ERROR_BODY_BYTES = 8 * 1024;
function openAIHeaders(token, accept = 'application/json') {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: accept,
  };
}
export function responsesRequest(body) {
  if (typeof body.model !== 'string' || !body.model.trim() || !Array.isArray(body.messages) || !body.messages.length) throw new CodexError('请选择 Codex 模型并提供消息。');
  const input = [];
  const instructions = [];
  for (const message of body.messages) {
    if (message.role === 'system' || message.role === 'developer') { instructions.push(typeof message.content === 'string' ? message.content : (message.content || []).map(p => p.text || '').join('\n')); continue; }
    if (message.role === 'tool') { input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }); continue; }
    if (message.role === 'assistant' && Array.isArray(message.codex_output)) {
      if (message.codex_output.some(item => !['reasoning', 'message', 'function_call'].includes(item.type))) throw new CodexError('不支持的 Codex 上下文类型。');
      input.push(...message.codex_output); continue;
    }
    if (!['user', 'assistant'].includes(message.role)) throw new CodexError('不支持的消息类型。');
    const textType = message.role === 'assistant' ? 'output_text' : 'input_text';
    const content = typeof message.content === 'string' ? [{ type: textType, text: message.content }] : (message.content || []).map(part => {
      if (['text', 'input_text', 'output_text'].includes(part.type)) return { type: textType, text: part.text };
      if (part.type === 'refusal' && message.role === 'assistant') return { type: 'refusal', refusal: part.refusal || part.text || '' };
      if (part.type === 'image_url' && message.role === 'user') return { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail || 'auto' };
      throw new CodexError('该附件暂不支持发送到 Codex。');
    });
    if (content.length) input.push({ role: message.role, content });
    for (const call of message.tool_calls || []) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, namespace: NAMESPACE, arguments: call.function.arguments });
  }
  const request = { model: body.model.trim(), input, instructions: instructions.join('\n\n') || 'You are a helpful assistant.', store: false, stream: true };
  if (body.tools?.length) {
    const tools = body.tools.map(tool => {
      if (tool.type !== 'function' || !tool.function?.name) throw new CodexError('Codex 目前只支持本地知识库函数工具。');
      return { type: 'function', name: tool.function.name, description: tool.function.description || '', parameters: tool.function.parameters || { type: 'object', properties: {} }, strict: false };
    });
    request.tools = [{ type: 'namespace', name: NAMESPACE, description: '检索用户在钉正中选择的本地学习资料。', tools }];
    request.tool_choice = ['auto', 'none', 'required'].includes(body.tool_choice) ? body.tool_choice : 'auto';
  }
  return request;
}

export function codexUpstreamError(status, data = {}, requestId = '') {
  const code = data.error?.code || data.code || '';
  const detail = typeof data.detail === 'string' ? data.detail : typeof data.error?.message === 'string' ? data.error.message : typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : '';
  const messages = {
    subscription_sharing_usage_limit_exceeded: 'ChatGPT 套餐或此应用的使用额度已达上限，请到 ChatGPT 设置 → Usage 查看。',
    subscription_sharing_user_not_eligible: '此账户或工作区暂不支持在钉正中使用 ChatGPT 套餐。',
    subscription_sharing_unsupported_capability: '当前模型或套餐通道不支持此次请求的功能，请更换模型后重试。',
    subscription_sharing_usage_unavailable: '暂时无法查询 ChatGPT 用量，请稍后重试。',
  };
  const message = messages[code] || (status === 401 ? 'ChatGPT 凭证未通过 OpenAI 校验。' : status === 429 ? 'ChatGPT 套餐额度不足或请求过于频繁，请稍后重试。' : status === 403 ? 'OpenAI 暂不允许此账户、工作区或所在地区完成请求。' : 'ChatGPT 请求失败，请稍后重试或检查模型是否可用。');
  const diagnostics = [code ? `错误码 ${String(code).slice(0, 100)}` : '', detail ? detail.slice(0, 300) : '', requestId ? `请求编号 ${String(requestId).slice(0, 100)}` : ''].filter(Boolean);
  return new CodexError(`${message}${diagnostics.length ? `（${diagnostics.join('：')}）` : ''}`, status >= 400 && status <= 599 ? status : 502, code || 'codex_upstream_error');
}

async function readLimitedText(stream, limit) {
  if (!stream) return { text: '', truncated: false };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';
  let truncated = false;
  try {
    while (bytesRead < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = limit - bytesRead;
      const visible = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      text += decoder.decode(visible, { stream: true });
      bytesRead += visible.byteLength;
      if (visible.byteLength < value.byteLength || bytesRead >= limit) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
    text += decoder.decode();
    return { text, truncated };
  } finally {
    reader.releaseLock();
  }
}

function frameHasSseData(frame) {
  const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
  if (!data) return false;
  if (data === '[DONE]') return true;
  try {
    const event = JSON.parse(data);
    return Boolean(event && typeof event === 'object' && typeof event.type === 'string');
  } catch {
    return false;
  }
}

function hasSseEvent(text, allowUnterminated = false) {
  const normalized = text.replace(/\r\n/g, '\n');
  let start = 0;
  while (start < normalized.length) {
    const end = normalized.indexOf('\n\n', start);
    if (end < 0) return allowUnterminated && frameHasSseData(normalized.slice(start));
    if (frameHasSseData(normalized.slice(start, end))) return true;
    start = end + 2;
  }
  return false;
}

function replayStream(reader, initialChunks) {
  let chunkIndex = 0;
  return new ReadableStream({
    async pull(controller) {
      if (chunkIndex < initialChunks.length) {
        controller.enqueue(initialChunks[chunkIndex++]);
        return;
      }
      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          reader.releaseLock();
        } else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        try { reader.releaseLock(); } catch {}
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { reader.releaseLock(); }
    },
  });
}

async function probeSseBody(stream) {
  const reader = stream.getReader();
  const chunks = [];
  const decoder = new TextDecoder();
  let text = '';
  let bytesRead = 0;
  let isSse = false;
  let ended = false;
  try {
    while (bytesRead < MAX_SSE_PROBE_BYTES) {
      const { value, done } = await reader.read();
      if (done) { ended = true; break; }
      chunks.push(value);
      bytesRead += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (hasSseEvent(text)) { isSse = true; break; }
    }
    if (ended) {
      text += decoder.decode();
      isSse = hasSseEvent(text, true);
    }
    return { isSse, stream: replayStream(reader, chunks) };
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    reader.releaseLock();
    throw error;
  }
}

async function unexpectedResponseError(response, body = response.body) {
  const contentType = response.headers.get('content-type') || '';
  const requestId = response.headers.get('x-request-id') || response.headers.get('openai-request-id') || '';
  const { text, truncated } = await readLimitedText(body, MAX_ERROR_BODY_BYTES);
  let data = {};
  try { data = JSON.parse(text); } catch {}
  const code = data.error?.code || data.code || '';
  const detail = typeof data.detail === 'string' ? data.detail : typeof data.error?.message === 'string' ? data.error.message : typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : '';
  if (code && Object.hasOwn({
    subscription_sharing_usage_limit_exceeded: true,
    subscription_sharing_user_not_eligible: true,
    subscription_sharing_unsupported_capability: true,
    subscription_sharing_usage_unavailable: true,
  }, code)) return codexUpstreamError(response.status === 200 ? 502 : response.status, data);
  const parts = [`HTTP ${response.status}`, contentType || '无 Content-Type'];
  if (!text) parts.push('响应体为空');
  if (code) parts.push(`错误码 ${String(code).slice(0, 100)}`);
  if (requestId) parts.push(`请求编号 ${String(requestId).slice(0, 100)}`);
  if (truncated) parts.push('诊断正文已截断');
  const suffix = detail ? `：${detail.slice(0, 300)}` : text && !Object.keys(data).length ? '：响应体不是可识别的 JSON 或 SSE 数据' : '';
  return new CodexError(`Codex 返回了非流式响应（${parts.join('，')}）${suffix}`, 502, code || 'unexpected_response_type');
}

export async function* sseEvents(stream) {
  const decoder = new TextDecoder(); let buffer = '';
  const parse = frame => {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return null;
    try { return JSON.parse(data); } catch { throw new CodexError('Codex 返回了无法解析的流式数据。', 502); }
  };
  for await (const bytes of stream) {
    buffer += decoder.decode(bytes, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const event = parse(buffer.slice(0, end)); buffer = buffer.slice(end + 2);
      if (event) yield event;
    }
    if (buffer.length > 8 * 1024 * 1024) throw new CodexError('Codex 响应过大，请缩小输入范围。', 502);
  }
  buffer += decoder.decode();
  if (buffer.trim()) { const event = parse(buffer); if (event) yield event; }
}

function chatResult(response, fallbackText) {
  const output = response.output || [];
  const content = output.filter(item => item.type === 'message').flatMap(item => item.content || []).filter(part => part.type === 'output_text' || part.type === 'refusal').map(part => part.text || part.refusal || '').join('');
  const calls = output.filter(item => item.type === 'function_call').map(item => ({ id: item.call_id, type: 'function', function: { name: item.name.replace(/^dingzheng\./, ''), arguments: item.arguments } }));
  const usage = response.usage;
  return { id: response.id, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: content || fallbackText, ...(calls.length ? { tool_calls: calls, codex_output: output } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }], ...(usage ? { usage: { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0, total_tokens: usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0) } } : {}) };
}

export async function listCodexModels(auth) {
  const { token } = await auth.accessToken();
  const response = await auth.fetch(`${OPENAI_API}/models`, { headers: openAIHeaders(token), signal: AbortSignal.timeout(30_000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw codexUpstreamError(response.status, data, response.headers.get('x-request-id') || response.headers.get('openai-request-id') || '');
  if (!Array.isArray(data.models)) throw new CodexError('OpenAI 返回的模型列表格式无效。', 502);
  return data.models.filter(model => model.visibility === 'list' && typeof model.slug === 'string').map(model => ({ id: model.slug, name: model.display_name || model.slug }));
}

export async function codexCompletion(auth, body, { signal, onDelta } = {}) {
  const request = responsesRequest(body);
  const { token, generation } = await auth.accessToken();
  const controller = new AbortController();
  auth.requests.add(controller);
  try {
    if (generation !== auth.generation) throw new CodexError('登录账户已经变更，请重试。', 409);
    const response = await auth.fetch(`${OPENAI_API}/responses`, { method: 'POST', headers: openAIHeaders(token, 'text/event-stream'), body: JSON.stringify(request), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000), ...(signal ? [signal] : [])]) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw codexUpstreamError(response.status, data, response.headers.get('x-request-id') || response.headers.get('openai-request-id') || '');
    }
    let stream = response.body;
    const contentType = response.headers.get('content-type') || '';
    if (!stream) throw await unexpectedResponseError(response, null);
    if (!contentType.includes('text/event-stream')) {
      if (contentType) throw await unexpectedResponseError(response);
      const probe = await probeSseBody(stream);
      if (!probe.isSse) throw await unexpectedResponseError(response, probe.stream);
      stream = probe.stream;
    }
    let text = '';
    for await (const event of sseEvents(stream)) {
      if (event.type === 'response.output_text.delta') { text += event.delta || ''; if (event.delta) await onDelta?.(event.delta); }
      if (event.type === 'error' || event.type === 'response.failed') throw codexUpstreamError(event.response?.error?.code === 'subscription_sharing_usage_limit_exceeded' ? 429 : 502, event.response || event);
      if (event.type === 'response.incomplete') throw new CodexError('Codex 输出未完成，请缩小输入或重新请求。', 502);
      if (event.type === 'response.completed') {
        if (event.response?.status !== 'completed') throw new CodexError('Codex 没有完成此次请求。', 502);
        return chatResult(event.response, text);
      }
    }
    throw new CodexError('Codex 连接提前中断，结果尚未完成，请重试。', 502);
  } finally { auth.requests.delete(controller); }
}
