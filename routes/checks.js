const express = require('express');
const http = require('http');
const db = require('../db');
const checker = require('../services/checker');
const oauthAutomation = require('../services/oauth-automation');
const quotaSync = require('../services/quota-sync');
const workspaceSync = require('../services/workspace-sync');
const memberOverflowRebalance = require('../services/member-overflow-rebalance');
const scheduler = require('../services/scheduler');

const router = express.Router();

let isChecking = false;

const OAUTH_CALLBACK_PORT = 1455;
const OAUTH_CALLBACK_ORIGIN = `http://localhost:${OAUTH_CALLBACK_PORT}`;
const OAUTH_FLOW_TIMEOUT_MS = 600000;
const OAUTH_AUTO_WAIT_TOKEN_MS = Math.max(
  5000,
  Number(process.env.OAUTH_AUTO_WAIT_TOKEN_MS || 15000)
);

// state -> { codeVerifier, accountId, accountEmail, timeoutId }
const activeOAuthFlows = new Map();
let oauthCallbackServer = null;
let oauthCallbackServerReady = false;
let oauthCallbackServerPromise = null;

function renderOAuthResponse(title, message, color) {
  return `
    <html>
      <body style="background:#0a0e17;color:${color};font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center;padding:24px">
          <h2 style="margin:0 0 12px">${title}</h2>
          <p style="color:#8b95a5;margin:0">${message}</p>
        </div>
      </body>
    </html>
  `;
}

function clearOAuthFlow(state) {
  const flow = activeOAuthFlows.get(state);
  if (flow?.timeoutId) {
    clearTimeout(flow.timeoutId);
  }
  activeOAuthFlows.delete(state);
}

function storeOAuthFlow(state, flow) {
  const timeoutId = setTimeout(() => {
    if (!activeOAuthFlows.has(state)) {
      return;
    }

    const timedOutFlow = activeOAuthFlows.get(state);
    clearOAuthFlow(state);
    console.log(`[OAuth] Flow timed out for ${timedOutFlow?.accountEmail || 'unknown account'}`);
  }, OAUTH_FLOW_TIMEOUT_MS);

  activeOAuthFlows.set(state, {
    ...flow,
    timeoutId,
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseOAuthCallbackUrl(callbackUrl) {
  if (callbackUrl instanceof URL) {
    return callbackUrl;
  }

  const raw = String(callbackUrl || '').trim();
  const compact = raw.replace(/\s+/g, '');
  const fullMatch = compact.match(/https?:\/\/localhost:1455\/auth\/callback\?[^"'<>]+/i);
  if (fullMatch) {
    return new URL(fullMatch[0]);
  }

  const queryStart = compact.includes('?')
    ? compact.slice(compact.indexOf('?') + 1)
    : compact.replace(/^.*?(?=code=|state=)/i, '');

  if (/code=/i.test(queryStart) && /state=/i.test(queryStart)) {
    return new URL(`/auth/callback?${queryStart}`, OAUTH_CALLBACK_ORIGIN);
  }

  return new URL(compact, OAUTH_CALLBACK_ORIGIN);
}

function createOAuthFlowForAccount(account) {
  const { authUrl, codeVerifier, state } = checker.startOAuthFlow(account.email);
  clearOAuthFlow(state);
  storeOAuthFlow(state, {
    codeVerifier,
    accountId: account.id,
    accountEmail: account.email,
  });
  return { authUrl, state };
}

async function waitForSavedOAuthToken(accountId, previousAccessToken, timeoutMs = OAUTH_AUTO_WAIT_TOKEN_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const account = db.prepare(`
      SELECT id, email, access_token, refresh_token
      FROM accounts
      WHERE id = ?
    `).get(accountId);

    if (account?.access_token && account.access_token !== previousAccessToken) {
      return account;
    }

    await sleep(500);
  }

  throw new Error('OAuth token was not saved after the callback completed.');
}

async function handleOAuthCallback(cbReq, cbRes) {
  const url = new URL(cbReq.url, OAUTH_CALLBACK_ORIGIN);

  if (url.pathname !== '/auth/callback') {
    cbRes.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    cbRes.end('Not found');
    return;
  }

  try {
    await completeOAuthAuthorizationFromUrl(url);

    cbRes.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    cbRes.end(renderOAuthResponse(
      'Authorization completed',
      'Tokens were saved successfully. You can close this page now.',
      '#10b981'
    ));

    console.log('[OAuth] Authorization completed via callback listener');
  } catch (err) {
    cbRes.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    cbRes.end(renderOAuthResponse('Token exchange failed', err.message, '#ef4444'));
    console.error('[OAuth] Token exchange failed via callback listener:', err.message);
  }
}

async function completeOAuthAuthorizationFromUrl(callbackUrl) {
  const url = parseOAuthCallbackUrl(callbackUrl);

  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const errorDesc = url.searchParams.get('error_description') || error || 'OAuth request failed';
  const flow = returnedState ? activeOAuthFlows.get(returnedState) : null;

  if (!returnedState || !flow) {
    throw new Error('This OAuth request is no longer active. Please start again from the dashboard.');
  }

  if (error) {
    clearOAuthFlow(returnedState);
    throw new Error(errorDesc);
  }

  if (!code) {
    clearOAuthFlow(returnedState);
    throw new Error('Missing authorization code.');
  }

  try {
    const tokens = await checker.exchangeCodeForTokens(code, flow.codeVerifier);

    db.prepare(`
      UPDATE accounts
      SET access_token = ?, refresh_token = ?, status = 'active',
          last_checked = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(tokens.access_token, tokens.refresh_token || '', flow.accountId);

    db.prepare(`
      INSERT INTO check_logs (account_id, status, message)
      VALUES (?, 'active', 'OAuth authorized successfully')
    `).run(flow.accountId);

    quotaSync.syncSingleAccountUsage(flow.accountId).catch(syncErr => {
      console.error(`[OAuth] Quota sync failed for ${flow.accountEmail}:`, syncErr.message);
    });

    const authorizedAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(flow.accountId);
    if (authorizedAccount && authorizedAccount.access_token) {
      workspaceSync.syncAccountWorkspaces(authorizedAccount).catch(syncErr => {
        console.error(`[OAuth] Workspace sync failed for ${flow.accountEmail}:`, syncErr.message);
      });
    }

    console.log(`[OAuth] Account ${flow.accountEmail} authorized successfully`);
    return {
      success: true,
      accountId: flow.accountId,
      accountEmail: flow.accountEmail,
    };
  } finally {
    clearOAuthFlow(returnedState);
  }
}

function ensureOAuthCallbackServer() {
  if (oauthCallbackServerReady) {
    return Promise.resolve();
  }

  if (oauthCallbackServerPromise) {
    return oauthCallbackServerPromise;
  }

  oauthCallbackServerPromise = new Promise((resolve, reject) => {
    const server = http.createServer((cbReq, cbRes) => {
      handleOAuthCallback(cbReq, cbRes).catch(err => {
        console.error('[OAuth] Callback handler error:', err.message);
        if (!cbRes.headersSent) {
          cbRes.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          cbRes.end(renderOAuthResponse('OAuth callback error', err.message, '#ef4444'));
        }
      });
    });

    const rejectStartup = (err) => {
      oauthCallbackServerPromise = null;
      if (oauthCallbackServer === server) {
        oauthCallbackServer = null;
      }
      reject(err);
    };

    server.on('error', (err) => {
      if (!oauthCallbackServerReady) {
        if (err.code === 'EADDRINUSE') {
          rejectStartup(new Error(`Port ${OAUTH_CALLBACK_PORT} is already in use. Please close the other process using it and try again.`));
          return;
        }

        rejectStartup(err);
        return;
      }

      console.error('[OAuth] Shared callback server error:', err.message);
    });

    server.on('close', () => {
      if (oauthCallbackServer === server) {
        oauthCallbackServer = null;
      }
      oauthCallbackServerReady = false;
      oauthCallbackServerPromise = null;
    });

    server.listen(OAUTH_CALLBACK_PORT, () => {
      oauthCallbackServer = server;
      oauthCallbackServerReady = true;
      oauthCallbackServerPromise = null;
      console.log(`[OAuth] Shared callback server listening on port ${OAUTH_CALLBACK_PORT}`);
      resolve();
    });
  });

  return oauthCallbackServerPromise;
}

router.post('/run', async (req, res) => {
  if (isChecking) {
    return res.status(409).json({ error: 'A check is already in progress' });
  }

  isChecking = true;
  res.json({ message: 'Check started', status: 'running' });

  try {
    await scheduler.runCheckCycle('manual');
  } catch (err) {
    console.error('[Checks] Bulk check error:', err.message);
  } finally {
    isChecking = false;
  }
});

router.post('/:id(\\d+)', async (req, res) => {
  try {
    const result = await checker.checkSingleAccount(Number.parseInt(req.params.id, 10));
    if (result.status === checker.STATUS.ACTIVE) {
      const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(result.id);
      if (account && account.access_token) {
        await workspaceSync.syncAccountWorkspaces(account).catch(err => {
          console.error('[Checks] Workspace sync failed after single check:', err.message);
        });

        await memberOverflowRebalance.rebalanceOverflowMembers().catch(err => {
          console.error('[Checks] Overflow rebalance failed after single check:', err.message);
        });
      }

      await quotaSync.syncSingleAccountUsage(result.id).catch(err => {
        console.error('[Checks] Quota sync failed after single check:', err.message);
      });
    }

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/status', (req, res) => {
  res.json({ isChecking });
});

router.get('/logs', (req, res) => {
  const { account_id, limit = 100, page = 1, visible_only: visibleOnly } = req.query;
  let query = `
    SELECT cl.*, a.email, a.label
    FROM check_logs cl
    JOIN accounts a ON cl.account_id = a.id
  `;
  const params = [];
  const conditions = [];

  if (account_id) {
    conditions.push('cl.account_id = ?');
    params.push(account_id);
  } else if (String(visibleOnly || '').toLowerCase() === 'true') {
    conditions.push(`a.status != 'invalid_credentials'`);
  }

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')}`;
  }

  query += ' ORDER BY cl.checked_at DESC';

  const offset = (Number.parseInt(page, 10) - 1) * Number.parseInt(limit, 10);
  query += ' LIMIT ? OFFSET ?';
  params.push(Number.parseInt(limit, 10), offset);

  const logs = db.prepare(query).all(...params);
  res.json({ logs });
});

router.post('/oauth/start/:id', (req, res) => {
  const accountId = Number.parseInt(req.params.id, 10);
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }

  ensureOAuthCallbackServer()
    .then(() => {
      const { authUrl, state } = createOAuthFlowForAccount(account);
      res.json({ authUrl, state });
    })
    .catch(err => {
      const message = err.message?.includes(`Port ${OAUTH_CALLBACK_PORT}`)
        ? `端口 ${OAUTH_CALLBACK_PORT} 已被占用，请先关闭其他使用此端口的程序`
        : (err.message || 'OAuth callback server failed to start');
      console.error('[OAuth] Failed to start callback server:', err.message);
      res.status(500).json({ error: message });
    });
});

router.post('/oauth/auto/:id', async (req, res) => {
  const accountId = Number.parseInt(req.params.id, 10);
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }

  let authUrl = '';
  let state = '';

  try {
    await ensureOAuthCallbackServer();
    const flow = createOAuthFlowForAccount(account);
    authUrl = flow.authUrl;
    state = flow.state;

    if (!account.password) {
      return res.status(409).json({
        error: '该账号没有保存密码，无法自动授权，请使用人工授权备用流程',
        authUrl,
        state,
        manual_fallback: true,
      });
    }

    await oauthAutomation.authorizeOAuthInBrowser({
      authUrl,
      email: account.email,
      password: account.password,
    });

    const authorizedAccount = await waitForSavedOAuthToken(
      accountId,
      account.access_token || ''
    );

    return res.json({
      success: true,
      message: `OAuth 授权已自动完成：${authorizedAccount.email}`,
      account_id: authorizedAccount.id,
      account_email: authorizedAccount.email,
    });
  } catch (err) {
    const message = err.message || 'OAuth auto authorization failed';
    console.error(`[OAuth] Auto authorization failed for ${account.email}:`, message);

    return res.status(400).json({
      error: `自动授权失败：${message}`,
      authUrl,
      state,
      manual_fallback: true,
    });
  }
});

router.post('/oauth/complete', async (req, res) => {
  const callbackUrl = String(req.body?.callback_url || req.body?.callbackUrl || '').trim();
  if (!callbackUrl) {
    return res.status(400).json({ error: 'Missing callback URL' });
  }

  try {
    const result = await completeOAuthAuthorizationFromUrl(callbackUrl);
    return res.json({
      success: true,
      message: `OAuth 授权已完成：${result.accountEmail}`,
      account_id: result.accountId,
      account_email: result.accountEmail,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'OAuth completion failed' });
  }
});

module.exports = router;
