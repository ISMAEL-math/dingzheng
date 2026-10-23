import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { CodexAuth } from '../codex-auth.mjs';
import { codexCompletion, listCodexModels, responsesRequest } from '../codex-provider.mjs';

const ISSUER = 'https://auth.openai.com';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

async function authFixture({ idTokenAccountId = true, accessTokenAccountId = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dingzheng-codex-test-'));
  const { publicKey, privateKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  let nonce = '';
  let refreshCalls = 0;
  const tokenCalls = [];
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    if (href === `${ISSUER}/.well-known/openid-configuration`) return json({
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`,
    });
    if (href === `${ISSUER}/.well-known/jwks.json`) return json({ keys: [jwk] });
    if (href === `${ISSUER}/api/accounts/oauth/token`) {
      const form = new URLSearchParams(options.body);
      tokenCalls.push(Object.fromEntries(form));
      if (form.get('grant_type') === 'refresh_token') {
        refreshCalls++;
        return json({ access_token: 'access-refreshed', refresh_token: 'refresh-rotated', token_type: 'Bearer', expires_in: 3600, scope: SCOPE });
      }
      const clientId = form.get('client_id');
      const accessToken = accessTokenAccountId
        ? await new SignJWT({ 'https://api.openai.com/auth': { chatgpt_account_id: 'chatgpt-account-1' } }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(ISSUER).setAudience('https://api.openai.com/v1').setSubject('subject-1').setIssuedAt().setExpirationTime('1h').sign(privateKey)
        : 'access-initial';
      const idClaims = { nonce, email: 'learner@example.test', ...(idTokenAccountId ? { 'https://api.openai.com/auth': { chatgpt_account_id: 'chatgpt-account-1' } } : {}) };
      const idToken = await new SignJWT(idClaims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(ISSUER).setAudience(clientId).setSubject('subject-1').setIssuedAt().setExpirationTime('1h').sign(privateKey);
      return json({ access_token: accessToken, refresh_token: 'refresh-initial', id_token: idToken, token_type: 'Bearer', expires_in: 3600, scope: SCOPE });
    }
    if (href === `${ISSUER}/api/accounts/oauth/revoke`) return new Response(null, { status: 200 });
    throw new Error(`Unexpected mock request: ${href}`);
  };
  const auth = new CodexAuth({
    directory, fetchImpl,
    createServerImpl: () => ({
      once() { return this; },
      listen(_port, _host, callback) { callback(); },
      address() { return { port: 43123 }; },
      close() { this.closed = true; },
    }),
  });
  return { auth, directory, tokenCalls, setNonce(value) { nonce = value; }, get refreshCalls() { return refreshCalls; } };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function responseSink() {
  return {
    status: 0, headers: {}, body: '', writableEnded: false,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(body = '') { this.body += body; this.writableEnded = true; },
  };
}

async function completeLogin(fixture, overrides = {}) {
  const started = await fixture.auth.startLogin();
  const authorize = new URL(started.authorizationUrl);
  fixture.setNonce(authorize.searchParams.get('nonce'));
  const state = overrides.state ?? authorize.searchParams.get('state');
  const clientId = overrides.clientId ?? 'oaiapp_test-registration';
  const params = new URLSearchParams({ code: 'one-time-code', state, client_id: clientId, ...(overrides.extra || {}) });
  const res = responseSink();
  await fixture.auth.callback({ method: 'GET', url: `/auth/callback?${params}` }, res, fixture.auth.pending);
  return { authorize, res, clientId };
}

test('first sign-in creates the documented loopback authorization request and validates the callback', async t => {
  const f = await authFixture();
  t.after(async () => { await f.auth.cancelLogin(); await rm(f.directory, { recursive: true, force: true }); });
  const { authorize, res, clientId } = await completeLogin(f);
  assert.equal(authorize.origin, ISSUER);
  assert.equal(authorize.pathname, '/api/accounts/authorize');
  assert.equal(authorize.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(authorize.searchParams.get('agent_name_hint'), '钉正');
  assert.match(authorize.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
  assert.deepEqual(authorize.searchParams.get('scope').split(' ').sort(), SCOPE.split(' ').sort());
  assert.match(authorize.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(res.status, 200);
  const status = await f.auth.status();
  assert.equal(status.connected, true);
  assert.equal(status.planEnabled, true);
  assert.equal(status.email, 'learner@example.test');
  assert.equal(f.tokenCalls[0].client_id, clientId);
  assert.equal(f.tokenCalls[0].redirect_uri, authorize.searchParams.get('redirect_uri'));
  assert.equal(f.tokenCalls[0].resource, 'https://api.openai.com/v1');
  assert.equal((await f.auth.accessToken()).accountId, 'chatgpt-account-1');
  assert.equal(JSON.stringify(status).includes('access-initial'), false);
  assert.equal(JSON.stringify(status).includes('refresh-initial'), false);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.directory, 'session.json'))).mode & 0o777, 0o600);
});

test('account identity falls back to the access-token claim when the ID token omits it', async t => {
  const f = await authFixture({ idTokenAccountId: false });
  t.after(async () => { await f.auth.cancelLogin(); await rm(f.directory, { recursive: true, force: true }); });
  await completeLogin(f);
  assert.equal((await f.auth.accessToken()).accountId, 'chatgpt-account-1');
  assert.equal(f.auth.active().chatgpt_account_id, 'chatgpt-account-1');
});

test('login remains usable when neither token exposes an account ID', async t => {
  const f = await authFixture({ idTokenAccountId: false, accessTokenAccountId: false });
  t.after(async () => { await f.auth.cancelLogin(); await rm(f.directory, { recursive: true, force: true }); });
  await completeLogin(f);
  const credentials = await f.auth.accessToken();
  assert.equal(credentials.token, 'access-initial');
  assert.equal(credentials.accountId, '');
});

test('invalid callback state never exchanges the authorization code', async t => {
  const f = await authFixture();
  t.after(async () => { await f.auth.cancelLogin(); await rm(f.directory, { recursive: true, force: true }); });
  const { authorize } = await f.auth.startLogin().then(async value => {
    const authorize = new URL(value.authorizationUrl);
    f.setNonce(authorize.searchParams.get('nonce'));
    const res = responseSink();
    await f.auth.callback({ method: 'GET', url: `/auth/callback?${new URLSearchParams({ code: 'bad', state: 'wrong-state', client_id: 'oaiapp_bad' })}` }, res, f.auth.pending);
    assert.equal(res.status, 400);
    return { authorize };
  });
  assert.ok(authorize.searchParams.get('state'));
  assert.equal(f.tokenCalls.length, 0);
  assert.equal((await f.auth.status()).connected, false);
});

test('ID-token nonce mismatch does not persist an account', async t => {
  const f = await authFixture();
  t.after(async () => { await f.auth.cancelLogin(); await rm(f.directory, { recursive: true, force: true }); });
  const started = await f.auth.startLogin();
  const authorize = new URL(started.authorizationUrl);
  f.setNonce('a-different-nonce');
  const res = responseSink();
  await f.auth.callback({ method: 'GET', url: `/auth/callback?${new URLSearchParams({ code: 'one-time-code', state: authorize.searchParams.get('state'), client_id: 'oaiapp_test-registration' })}` }, res, f.auth.pending);
  assert.equal(res.status, 400);
  assert.equal((await f.auth.status()).connected, false);
  assert.match((await f.auth.status()).error, /账户校验失败/);
});

test('refresh rotation is serialized and sign-out revokes then clears local credentials', async t => {
  const f = await authFixture();
  t.after(async () => { await f.auth.cancelLogin(); await rm(f.directory, { recursive: true, force: true }); });
  await completeLogin(f);
  const account = f.auth.active();
  account.expiresAt = Date.now() - 1;
  await f.auth.persist();
  const tokens = await Promise.all(Array.from({ length: 5 }, () => f.auth.accessToken()));
  assert.equal(f.refreshCalls, 1);
  assert.ok(tokens.every(token => token.token === 'access-refreshed'));
  assert.ok(tokens.every(token => token.accountId === 'chatgpt-account-1'));
  assert.equal(f.auth.active().refresh_token, 'refresh-rotated');
  const result = await f.auth.disconnect();
  assert.equal(result.revoked, true);
  assert.equal((await f.auth.status()).connected, false);
  const disk = await readFile(join(f.directory, 'session.json'), 'utf8');
  assert.equal(disk.includes('refresh-rotated'), false);
});

test('Responses request keeps images and local namespace tools without unsupported API-only options', () => {
  const req = responsesRequest({
    model: 'gpt-test', max_tokens: 123, temperature: 0.2,
    messages: [
      { role: 'system', content: 'Be helpful.' },
      { role: 'user', content: [{ type: 'text', text: 'Read this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==', detail: 'high' } }] },
      { role: 'assistant', content: 'Previous answer' },
      { role: 'assistant', tool_calls: [{ id: 'call-1', function: { name: 'search_local', arguments: '{"q":"x"}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'found' },
    ],
    tools: [{ type: 'function', function: { name: 'search_local', description: 'Search local study files', parameters: { type: 'object', properties: {} } } }],
  });
  assert.equal(req.model, 'gpt-test');
  assert.equal(req.store, false);
  assert.equal(req.stream, true);
  assert.equal(req.instructions, 'Be helpful.');
  assert.equal('include' in req, false);
  assert.equal(req.instructions, 'Be helpful.');
  assert.equal(req.input[0].content[0].type, 'input_text');
  assert.equal(req.input[0].content[1].type, 'input_image');
  assert.equal(req.input[1].content[0].type, 'output_text');
  assert.equal(req.input[2].type, 'function_call');
  assert.equal(req.input[2].namespace, 'dingzheng');
  assert.equal(req.input[3].type, 'function_call_output');
  assert.equal(req.tools[0].type, 'namespace');
  assert.equal(req.tools[0].name, 'dingzheng');
  assert.equal('temperature' in req, false);
  assert.equal('max_tokens' in req, false);
});

test('Codex completion requires response.completed and surfaces late usage-limit errors', async () => {
  const requestBodies = [];
  const upstreamRequests = [];
  const mockAuth = {
    generation: 0, requests: new Set(), accessToken: async () => ({ token: 'oauth-access', accountId: 'chatgpt-account-1', generation: 0 }),
    fetch: async (url, options) => {
      upstreamRequests.push({ url: String(url), headers: options.headers });
      requestBodies.push(JSON.parse(options.body));
      const events = [
        { type: 'response.output_text.delta', delta: 'partial text' },
        { type: 'error', error: { code: 'subscription_sharing_usage_limit_exceeded' } },
      ];
      const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 19)); controller.enqueue(bytes.slice(19)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  };
  const deltas = [];
  await assert.rejects(codexCompletion(mockAuth, { model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] }, { onDelta: value => deltas.push(value) }), error => {
    assert.match(error.message, /额度已达上限/);
    assert.equal(error.code, 'subscription_sharing_usage_limit_exceeded');
    return true;
  });
  assert.deepEqual(deltas, ['partial text']);
  assert.equal(requestBodies[0].store, false);
  assert.equal(upstreamRequests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(upstreamRequests[0].headers.Authorization, 'Bearer oauth-access');
  assert.equal(Object.hasOwn(upstreamRequests[0].headers, 'ChatGPT-Account-ID'), false);
  assert.equal(Object.hasOwn(upstreamRequests[0].headers, 'OpenAI-Beta'), false);
  assert.equal(mockAuth.requests.size, 0);
});

test('Codex completion turns a completed response into the app chat format', async () => {
  const output = [{ type: 'reasoning', encrypted_content: 'opaque' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'connected' }] }];
  const mockAuth = {
    generation: 0, requests: new Set(), accessToken: async () => ({ token: 'oauth-access', accountId: 'chatgpt-account-1', generation: 0 }),
    fetch: async () => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp-1', status: 'completed', output, usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }),
  };
  const result = await codexCompletion(mockAuth, { model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(result.choices[0].message.content, 'connected');
  assert.equal(result.usage.total_tokens, 6);
  assert.equal(mockAuth.requests.size, 0);
});

test('Codex non-stream responses include upstream JSON detail in the error', async () => {
  const mockAuth = {
    generation: 0, requests: new Set(), accessToken: async () => ({ token: 'oauth-access', accountId: 'chatgpt-account-1', generation: 0 }),
    fetch: async () => new Response(JSON.stringify({ detail: 'Stream must be set to true' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  };
  await assert.rejects(codexCompletion(mockAuth, { model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] }), error => {
    assert.match(error.message, /非流式响应/);
    assert.match(error.message, /Stream must be set to true/);
    return true;
  });
});

test('ChatGPT model catalog uses the direct Responses API with the OAuth bearer token', async () => {
  let request;
  const mockAuth = {
    accessToken: async () => ({ token: 'oauth-access', accountId: 'chatgpt-account-1' }),
    fetch: async (url, options) => {
      request = { url: String(url), headers: options.headers };
      return json({ models: [{ slug: 'gpt-test', display_name: 'GPT Test', visibility: 'list' }] });
    },
  };
  const models = await listCodexModels(mockAuth);
  assert.deepEqual(models, [{ id: 'gpt-test', name: 'GPT Test' }]);
  assert.equal(request.url, 'https://api.openai.com/v1/models');
  assert.equal(request.headers.Authorization, 'Bearer oauth-access');
  assert.equal(Object.hasOwn(request.headers, 'ChatGPT-Account-ID'), false);
});

test('ChatGPT model catalog works without an optional account ID claim', async () => {
  let request;
  const auth = {
    accessToken: async () => ({ token: 'oauth-access', accountId: '', generation: 0 }),
    fetch: async (url, options) => {
      request = { url: String(url), headers: options.headers };
      return json({ models: [{ slug: 'gpt-test', display_name: 'GPT Test', visibility: 'list' }] });
    },
  };
  assert.deepEqual(await listCodexModels(auth), [{ id: 'gpt-test', name: 'GPT Test' }]);
  assert.equal(request.url, 'https://api.openai.com/v1/models');
  assert.equal(request.headers.Authorization, 'Bearer oauth-access');
  assert.equal(Object.hasOwn(request.headers, 'ChatGPT-Account-ID'), false);
});

test('model catalog errors preserve direct-route diagnostics and request ID', async () => {
  const auth = {
    accessToken: async () => ({ token: 'oauth-access', accountId: '', generation: 0 }),
    fetch: async () => new Response(JSON.stringify({ detail: 'The signed identity is invalid.' }), { status: 401, headers: { 'Content-Type': 'application/json', 'x-request-id': 'request-123' } }),
  };
  await assert.rejects(listCodexModels(auth), error => {
    assert.match(error.message, /The signed identity is invalid/);
    assert.match(error.message, /request-123/);
    return true;
  });
});
