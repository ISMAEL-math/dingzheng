import http from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createRemoteJWKSet, jwtVerify, customFetch } from 'jose';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const random = () => randomBytes(32).toString('base64url');
function chatgptAccountIdFromToken(token) {
  try {
    const [header, payload, signature, ...extra] = token.split('.');
    if (!header || !payload || !signature || extra.length) return '';
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id || claims.chatgpt_account_id || claims.account_id;
    return typeof accountId === 'string' && accountId.trim() ? accountId.trim() : '';
  } catch { return ''; }
}
export class CodexError extends Error {
  constructor(message, status = 400, code = 'codex_error') { super(message); this.status = status; this.code = code; }
}

// Only expose account labels and connection state, never OAuth artifacts.
export class CodexAuth {
  constructor({ directory, fetchImpl = fetch, createServerImpl = http.createServer, now = Date.now, loginTimeout = 300_000 }) {
    this.directory = directory;
    this.fetch = fetchImpl;
    this.createServer = createServerImpl;
    this.now = now;
    this.loginTimeout = loginTimeout;
    this.queue = Promise.resolve();
    this.pending = null;
    this.loginState = 'idle';
    this.loginError = '';
    this.generation = 0;
    this.requests = new Set();
  }
  async locked(work) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  async load() {
    if (this.loaded) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const dir = await lstat(this.directory);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new CodexError('登录凭证目录不安全。', 500);
    await chmod(this.directory, 0o700);
    const path = join(this.directory, 'session.json');
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new CodexError('登录凭证文件不安全。', 500);
      await chmod(path, 0o600);
      this.store = JSON.parse(await readFile(path, 'utf8'));
      if (this.store.version !== 1 || typeof this.store.hostId !== 'string') throw new Error('invalid store');
    } catch (error) {
      if (error.code !== 'ENOENT') throw new CodexError('无法读取 Codex 登录凭证，请检查本机文件。', 500);
      this.store = { version: 1, hostId: `urn:uuid:${randomUUID()}`, accounts: [], activeId: null };
      await this.persist();
    }
    this.loaded = true;
  }
  async persist() {
    const temp = join(this.directory, `session-${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(this.store), { mode: 0o600, flag: 'wx' });
    await rename(temp, join(this.directory, 'session.json'));
  }
  active() { return this.store.accounts.find(account => account.id === this.store.activeId); }
  async status() {
    return this.locked(async () => {
      await this.load();
      const account = this.active();
      return {
        connected: Boolean(account?.access_token),
        planEnabled: Boolean(account?.access_token && account.scopes?.includes('chatgpt.tokens.use.direct')),
        email: account?.email || '',
        activeId: this.store.activeId,
        accounts: this.store.accounts.map(a => ({ id: a.id, email: a.email, label: `${a.email || 'ChatGPT 账户'} · ${a.client_id.slice(-6)}`, connected: Boolean(a.access_token) })),
        loginState: this.loginState, error: this.loginError,
      };
    });
  }
  async metadata() {
    if (this.discovery) return this.discovery;
    const response = await this.fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new CodexError('无法读取 OpenAI 登录配置，请稍后重试。', 502);
    const data = await response.json();
    if (data.issuer !== ISSUER && data.issuer !== `${ISSUER}/`) throw new CodexError('OpenAI 登录配置校验失败。', 502);
    for (const key of ['jwks_uri', 'revocation_endpoint']) {
      if (new URL(data[key]).origin !== ISSUER) throw new CodexError('OpenAI 登录地址校验失败。', 502);
    }
    this.discovery = data;
    this.jwks = createRemoteJWKSet(new URL(data.jwks_uri), { [customFetch]: this.fetch, timeoutDuration: 15_000 });
    return data;
  }
  stopPending() {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.server.close();
    this.pending = null;
  }
  async startLogin(accountId = null) {
    return this.locked(async () => {
      await this.load();
      this.stopPending();
      await this.metadata();
      const account = accountId ? this.store.accounts.find(a => a.id === accountId) : null;
      if (accountId && !account) throw new CodexError('找不到此账户，请重新添加。');
      const transaction = { state: random(), nonce: random(), verifier: random(), account, generation: this.generation, expiresAt: this.now() + this.loginTimeout };
      transaction.server = this.createServer((req, res) => { this.callback(req, res, transaction).catch(() => { if (!res.writableEnded) this.callbackPage(res, false); }); });
      transaction.server.headersTimeout = 10_000;
      transaction.server.requestTimeout = 15_000;
      await new Promise((resolve, reject) => { transaction.server.once('error', reject); transaction.server.listen(0, '127.0.0.1', resolve); });
      transaction.redirectUri = `http://127.0.0.1:${transaction.server.address().port}/auth/callback`;
      transaction.timer = setTimeout(() => {
        if (this.pending === transaction) { this.stopPending(); this.loginState = 'failed'; this.loginError = '登录已超时，请重新登录。'; }
      }, this.loginTimeout);
      transaction.timer.unref();
      this.pending = transaction;
      this.loginState = 'waiting'; this.loginError = '';
      const url = new URL(`${ISSUER}/api/accounts/authorize`);
      url.search = new URLSearchParams({
        client_id: account?.client_id || 'dynamic_agent_client',
        ...(account ? (account.email ? { login_hint: account.email } : {}) : { agent_name_hint: '钉正' }),
        ext_agent_host_id: this.store.hostId, response_type: 'code', redirect_uri: transaction.redirectUri,
        scope: SCOPE, resource: RESOURCE, state: transaction.state, nonce: transaction.nonce,
        code_challenge_method: 'S256', code_challenge: createHash('sha256').update(transaction.verifier).digest('base64url'),
      }).toString();
      return { authorizationUrl: url.href };
    });
  }
  callbackPage(res, success) {
    res.writeHead(success ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>钉正 · ChatGPT 登录</title><body style="font:16px system-ui;padding:48px;line-height:1.8"><h2>${success ? '登录已完成' : '登录未完成'}</h2><p>${success ? '请返回钉正，查看账户状态并选择模型。现在可以关闭此页面。' : '请返回钉正设置页查看原因，然后重试登录。'}</p></body></html>`);
  }
  async callback(req, res, transaction) {
    const url = new URL(req.url, transaction.redirectUri);
    const state = url.searchParams.get('state') || '';
    if (req.method !== 'GET' || url.pathname !== '/auth/callback' || url.searchParams.getAll('state').length !== 1 || state.length !== transaction.state.length || !timingSafeEqual(Buffer.from(state), Buffer.from(transaction.state))) {
      res.writeHead(400, { 'Cache-Control': 'no-store' }); res.end('Invalid callback'); return;
    }
    if (this.pending !== transaction || transaction.used || this.now() >= transaction.expiresAt) { this.callbackPage(res, false); return; }
    transaction.used = true; this.loginState = 'exchanging';
    try {
      if (url.searchParams.has('error')) throw new CodexError('你取消了授权，或账户暂不支持此登录方式。');
      const code = url.searchParams.get('code');
      const suppliedId = url.searchParams.get('client_id');
      const clientId = transaction.account?.client_id || suppliedId;
      if (!code || !clientId || clientId === 'dynamic_agent_client' || (suppliedId && suppliedId !== clientId)) throw new CodexError('登录回调缺少有效的应用注册信息，请重试。');
      const payload = await this.tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: transaction.verifier, redirect_uri: transaction.redirectUri, resource: RESOURCE });
      const { payload: identity } = await jwtVerify(payload.id_token, this.jwks, { issuer: this.discovery.issuer, audience: clientId, algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'exp', 'iat', 'nonce'], clockTolerance: 5 });
      if (identity.nonce !== transaction.nonce || (transaction.account && identity.sub !== transaction.account.subject)) throw new CodexError('登录账户校验失败，请重试。');
      await this.locked(async () => {
        if (this.pending !== transaction || transaction.generation !== this.generation) throw new CodexError('此次登录已取消。');
        const entry = this.credentials(payload, transaction.account || { id: randomUUID(), client_id: clientId, subject: identity.sub, email: identity.email || '' }, identity);
        const index = this.store.accounts.findIndex(a => a.id === entry.id);
        const accounts = [...this.store.accounts];
        if (index < 0) accounts.push(entry); else accounts[index] = entry;
        const previous = this.store;
        this.store = { ...this.store, accounts, activeId: entry.id };
        try { await this.persist(); } catch (error) { this.store = previous; throw error; }
        this.generation++; this.loginState = 'completed'; this.loginError = '';
        this.stopPending();
      });
      this.callbackPage(res, true);
    } catch (error) {
      if (this.pending === transaction) {
        this.loginState = 'failed';
        this.loginError = error instanceof CodexError ? error.message : 'OpenAI 登录验证失败，请重试；若持续失败，请检查网络或账户资格。';
        this.stopPending();
      }
      this.callbackPage(res, false);
    }
  }
  credentials(payload, previous, identity = {}) {
    if (typeof payload.access_token !== 'string' || !payload.access_token || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0 || typeof payload.refresh_token !== 'string' || !payload.refresh_token || !/^bearer$/i.test(payload.token_type || '')) throw new CodexError('OpenAI 返回的登录凭证不完整，请重新登录。', 502);
    return { ...previous, access_token: payload.access_token, refresh_token: payload.refresh_token, id_token: payload.id_token || previous.id_token,
      chatgpt_account_id: [payload.account_id, payload.chatgpt_account_id, identity['https://api.openai.com/auth']?.chatgpt_account_id,
        chatgptAccountIdFromToken(payload.access_token), chatgptAccountIdFromToken(payload.id_token || previous.id_token), previous.chatgpt_account_id]
        .find(value => typeof value === 'string' && value.trim())?.trim() || '',
      scopes: typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : previous.scopes || [], expiresAt: this.now() + payload.expires_in * 1000 };
  }
  async tokenRequest(body) {
    const response = await this.fetch(`${ISSUER}/api/accounts/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(30_000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = typeof data.error === 'string' ? data.error : data.error?.code;
      throw new CodexError('OpenAI 未能完成登录或续期，请检查账户授权后重试。', response.status >= 500 ? 502 : 401, code || 'token_exchange_failed');
    }
    return data;
  }
  async accessToken() {
    return this.locked(async () => {
      await this.load();
      let account = this.active();
      if (!account?.access_token) throw new CodexError('请先在设置中登录 Codex / ChatGPT。', 401);
      if (!account.scopes?.includes('chatgpt.tokens.use.direct')) throw new CodexError('已登录，但尚未授权使用 ChatGPT 套餐；请重新授权。', 403);
      if (account.expiresAt <= this.now() + 60_000) {
        try {
          account = this.credentials(await this.tokenRequest({ grant_type: 'refresh_token', client_id: account.client_id, refresh_token: account.refresh_token, resource: RESOURCE }), account);
          this.store.accounts = this.store.accounts.map(a => a.id === account.id ? account : a);
          await this.persist();
        } catch (error) {
          if (['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalid', 'refresh_token_invalidated', 'refresh_token_reused'].includes(error.code)) {
            this.clearTokens(account); await this.persist();
            throw new CodexError('登录已过期，请在设置中重新登录。', 401);
          }
          throw error;
        }
      }
      if (!account.scopes.includes('chatgpt.tokens.use.direct')) throw new CodexError('套餐授权已失效，请重新授权。', 403);
      const accountId = account.chatgpt_account_id || chatgptAccountIdFromToken(account.access_token) || chatgptAccountIdFromToken(account.id_token || '');
      if (accountId && !account.chatgpt_account_id) { account.chatgpt_account_id = accountId; await this.persist(); }
      return { token: account.access_token, accountId, generation: this.generation };
    });
  }
  clearTokens(account) { for (const field of ['access_token', 'refresh_token', 'id_token', 'expiresAt', 'scopes']) delete account[field]; }
  async cancelLogin() { return this.locked(async () => { this.stopPending(); this.loginState = 'idle'; this.loginError = ''; }); }
  async disconnect() {
    return this.locked(async () => {
      await this.load(); this.stopPending(); this.generation++;
      for (const controller of this.requests) controller.abort();
      const account = this.active(); let revoked = !account?.refresh_token;
      if (account?.refresh_token) {
        try {
          const metadata = await this.metadata();
          const response = await this.fetch(metadata.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: account.refresh_token, token_type_hint: 'refresh_token', client_id: account.client_id }), signal: AbortSignal.timeout(15_000) });
          revoked = response.status === 200;
        } catch {}
      }
      if (account) this.clearTokens(account);
      await this.persist(); this.loginState = 'idle'; this.loginError = '';
      return { revoked, message: revoked ? '已退出登录。' : '已在钉正退出，远程撤销未确认；你可在 ChatGPT 设置中断开此应用。' };
    });
  }
}
