import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from './api-client.js';
import { AUTH_REQUIRED_KIND, createAccountManager } from './accounts.js';

const dir = mkdtempSync(join(tmpdir(), 'echomind-acc-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function makeFakeApi() {
  const calls = [];
  return {
    calls,
    async health() { return { ok: true }; },
    async getFeishuConfig(_cfg, joinCode) {
      calls.push({ op: 'getFeishuConfig', joinCode });
      return {
        appId: 'cli_demo123',
        scopes: ['offline_access', 'task:task:write'],
        company: { name: joinCode === 'COMP2' ? '二号公司' : '善治数字', joinCode: joinCode || 'DEFAULT1' },
      };
    },
    async exchangeFeishuCode(_cfg, payload) {
      calls.push({ op: 'exchangeFeishuCode', payload });
      return {
        token: `tok_${payload.code}`,
        expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
        profile: { open_id: payload.company === 'COMP2' ? 'ou_user2' : 'ou_user1', name: payload.company === 'COMP2' ? '李四' : '张三' },
        missingScopes: [],
        company: { name: payload.company === 'COMP2' ? '二号公司' : '善治数字', joinCode: payload.company || 'DEFAULT1' },
      };
    },
    async getMe(cfg) {
      calls.push({ op: 'getMe', token: cfg.token });
      return { openId: 'ou_user1', name: '张三', admin: cfg.token === 'tok_code_admin', missingScopes: [] };
    },
    async logout(cfg) {
      calls.push({ op: 'logout', token: cfg.token });
      return { ok: true };
    },
  };
}

test('full browser PKCE loopback authorization, multi-company switch, 401 expiry, and disconnect revocation', async () => {
  const api = makeFakeApi();
  const configPath = join(dir, 'config-1.json');
  const mgr = createAccountManager(null, { apiClient: api, configPath, callbackPort: 0 });

  try {
    // 1. No account yet -> returns 约定 C
    const noAcc = await mgr.runBackend(async () => 'never');
    assert.equal(noAcc.ok, false);
    assert.equal(noAcc.authRequired.kind, AUTH_REQUIRED_KIND);
    assert.equal(noAcc.authRequired.reason, 'no-account');

    // 2. Start authorization -> opens ephemeral loopback server
    const started = await mgr.startAuthorization({ joinCode: 'SHANZHI' });
    assert.ok(started.verifyUrl.includes('accounts.feishu.cn'));
    const authUrl = new URL(started.verifyUrl);
    const stateParam = authUrl.searchParams.get('state');
    const redirectUri = authUrl.searchParams.get('redirect_uri');
    assert.ok(stateParam);
    assert.ok(redirectUri.startsWith('http://127.0.0.1:'));

    // Bad state must be rejected and keep pending
    const badRes = await fetch(`${redirectUri}?code=evil&state=wrong-state`);
    assert.equal(badRes.status, 400);
    assert.equal((await mgr.pollAuthorization(started.requestId)).status, 'pending');

    // Real callback completes PKCE exchange
    const okRes = await fetch(`${redirectUri}?code=code_admin&state=${encodeURIComponent(stateParam)}`);
    assert.equal(okRes.status, 200);

    const polled = await mgr.pollAuthorization(started.requestId);
    assert.equal(polled.status, 'approved');
    assert.equal(polled.account.name, '张三');
    assert.equal(polled.account.admin, true);

    // State never leaks plaintext token
    const st = await mgr.getState();
    assert.equal(JSON.stringify(st).includes('tok_code_admin'), false);
    assert.equal(st.accounts.length, 1);

    // 3. Connect second company account
    const started2 = await mgr.startAuthorization({ joinCode: 'COMP2' });
    const url2 = new URL(started2.verifyUrl);
    const res2 = await fetch(`${url2.searchParams.get('redirect_uri')}?code=code2&state=${encodeURIComponent(url2.searchParams.get('state'))}`);
    assert.equal(res2.status, 200);
    const polled2 = await mgr.pollAuthorization(started2.requestId);
    assert.equal(polled2.status, 'approved');
    assert.equal(polled2.account.companyName, '二号公司');

    const st2 = await mgr.getState();
    assert.equal(st2.accounts.length, 2);
    assert.equal(st2.activeAccount.name, '李四');

    // 4. 5xx error does NOT mark account expired
    await assert.rejects(
      () => mgr.runBackend(async () => { throw new ApiError('DB down', { code: 'SERVER_ERROR', status: 503 }); }),
      (err) => err.code === 'SERVER_ERROR',
    );
    assert.equal((await mgr.getState()).activeAccount.status, 'ok');

    // 5. 401 marks active account expired and returns 约定 C
    const expiredRes = await mgr.runBackend(async () => { throw new ApiError('expired', { code: 'UNAUTHORIZED', status: 401 }); });
    assert.equal(expiredRes.ok, false);
    assert.equal(expiredRes.authRequired.kind, AUTH_REQUIRED_KIND);
    assert.equal(expiredRes.authRequired.reason, 'expired');
    assert.equal((await mgr.getState()).activeAccount.status, 'expired');

    // 6. Changing serverUrl requires explicit disconnectAccounts: true
    await assert.rejects(
      () => mgr.saveSettings({ serverUrl: 'https://other.example.com' }),
      (err) => err.code === 'ACCOUNTS_EXIST',
    );

    // 7. Disconnect calls /v1/auth/logout and removes account
    const afterDisc = await mgr.disconnectAccount(st2.activeAccountId);
    assert.equal(afterDisc.accounts.length, 1);
    assert.ok(api.calls.some((c) => c.op === 'logout' && c.token === 'tok_code2'));
  } finally {
    mgr.dispose();
  }
});
