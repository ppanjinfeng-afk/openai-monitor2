const { getPuppeteer } = require('./inviter');
const { withBrowserTask } = require('./browser-task-queue');

const DEFAULT_TIMEOUT_MS = Math.max(
  30000,
  Number(process.env.OAUTH_AUTO_TIMEOUT_MS || 90000)
);
const PAGE_TIMEOUT_MS = Math.max(
  10000,
  Number(process.env.OAUTH_AUTO_PAGE_TIMEOUT_MS || 30000)
);
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-extensions',
  '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1280,800',
];

const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[name="username"]',
  'input[id="email"]',
  'input[id="username"]',
  'input[autocomplete="email"]',
  'input[autocomplete="username"]',
];

const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[id="password"]',
  'input[autocomplete="current-password"]',
];

const SUBMIT_TEXTS = [
  'continue',
  'next',
  'log in',
  'login',
  'sign in',
  'authorize',
  'allow',
  'accept',
  'confirm',
  'continue to',
  '继续',
  '下一步',
  '登录',
  '登入',
  '授权',
  '允许',
  '同意',
  '确认',
];

const HUMAN_REQUIRED_HINTS = [
  'captcha',
  'verify you are human',
  'security check',
  'two-factor',
  'two factor',
  '2fa',
  'mfa',
  'verification code',
  'passkey',
  'cloudflare',
  '验证码',
  '验证你是真人',
  '安全检查',
  '两步验证',
  '二次验证',
  '验证代码',
  '通行密钥',
];

const INVALID_LOGIN_HINTS = [
  'incorrect email or password',
  'wrong email or password',
  'invalid email or password',
  'invalid login',
  '账号或密码',
  '密码错误',
  '邮箱或密码错误',
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function readPageText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

async function fillFirstVisibleInput(page, selectors, value) {
  const selector = await page.evaluate((candidateSelectors) => {
    function isVisible(el) {
      if (!el || el.disabled || el.readOnly) {
        return false;
      }

      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && rect.width > 0
        && rect.height > 0;
    }

    return candidateSelectors.find(candidate => {
      try {
        return isVisible(document.querySelector(candidate));
      } catch {
        return false;
      }
    }) || '';
  }, selectors);

  if (!selector) {
    return false;
  }

  await page.evaluate((targetSelector, nextValue) => {
    const input = document.querySelector(targetSelector);
    if (!input) {
      return;
    }

    input.focus();
    input.value = nextValue;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector, value);

  return true;
}

async function clickBestAction(page) {
  return page.evaluate((texts) => {
    function isVisible(el) {
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') {
        return false;
      }

      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && rect.width > 0
        && rect.height > 0;
    }

    const candidates = [
      ...document.querySelectorAll('button'),
      ...document.querySelectorAll('input[type="submit"]'),
      ...document.querySelectorAll('a[role="button"]'),
      ...document.querySelectorAll('[role="button"]'),
    ];

    for (const el of candidates) {
      if (!isVisible(el)) {
        continue;
      }

      const label = String(
        el.innerText
          || el.textContent
          || el.value
          || el.getAttribute('aria-label')
          || ''
      ).replace(/\s+/g, ' ').trim().toLowerCase();

      if (!label) {
        continue;
      }

      if (texts.some(text => label.includes(text))) {
        el.click();
        return label;
      }
    }

    return '';
  }, SUBMIT_TEXTS);
}

function assertNoHumanStep(pageText) {
  const normalized = normalizeText(pageText);
  const humanHint = HUMAN_REQUIRED_HINTS.find(hint => normalized.includes(hint));
  if (humanHint) {
    throw new Error(`OpenAI 要求人工验证：${humanHint}`);
  }

  const invalidHint = INVALID_LOGIN_HINTS.find(hint => normalized.includes(hint));
  if (invalidHint) {
    throw new Error(`OpenAI 登录失败：${invalidHint}`);
  }
}

async function runOAuthAutomation(page, { authUrl, email, password, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let emailFilled = false;
  let passwordFilled = false;

  await page.goto(authUrl, {
    waitUntil: 'domcontentloaded',
    timeout: PAGE_TIMEOUT_MS,
  });

  while (Date.now() < deadline) {
    const currentUrl = page.url();
    if (/^http:\/\/localhost:1455\/auth\/callback/i.test(currentUrl)) {
      await sleep(1200);
      const callbackText = await readPageText(page);
      if (/token exchange failed|oauth callback error/i.test(callbackText)) {
        throw new Error(callbackText.replace(/\s+/g, ' ').trim() || 'OAuth 回调失败');
      }
      return { success: true, mode: 'callback' };
    }

    const pageText = await readPageText(page);
    if (/authorization completed|tokens were saved successfully|授权成功|令牌已保存/i.test(pageText)) {
      return { success: true, mode: 'success-page' };
    }
    assertNoHumanStep(pageText);

    let filledAnyField = false;
    const hasEmail = await page.$(EMAIL_SELECTORS.join(',')).catch(() => null);
    if (hasEmail && !emailFilled) {
      const filled = await fillFirstVisibleInput(page, EMAIL_SELECTORS, email);
      if (filled) {
        emailFilled = true;
        filledAnyField = true;
      }
    }

    const hasPassword = await page.$(PASSWORD_SELECTORS.join(',')).catch(() => null);
    if (hasPassword && !passwordFilled) {
      const filled = await fillFirstVisibleInput(page, PASSWORD_SELECTORS, password);
      if (filled) {
        passwordFilled = true;
        filledAnyField = true;
      }
    }

    if (filledAnyField) {
      await sleep(250);
      await clickBestAction(page);
      await sleep(1200);
      continue;
    }

    const clicked = await clickBestAction(page);
    if (clicked) {
      await sleep(1200);
      continue;
    }

    await sleep(800);
  }

  throw new Error('自动 OAuth 授权超时，请使用人工授权备用流程');
}

async function authorizeOAuthInBrowser({ authUrl, email, password, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!authUrl) {
    throw new Error('Missing OAuth authorization URL');
  }
  if (!email || !password) {
    throw new Error('账号没有保存邮箱或密码，无法自动授权');
  }

  return withBrowserTask(async () => {
    const pptr = await getPuppeteer();
    const browser = await pptr.launch({
      headless: 'new',
      args: BROWSER_ARGS,
      defaultViewport: { width: 1280, height: 800 },
    });

    try {
      const page = await browser.newPage();
      await page.setUserAgent(USER_AGENT);
      await page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
      await page.setDefaultTimeout(PAGE_TIMEOUT_MS);

      return await runOAuthAutomation(page, {
        authUrl,
        email,
        password,
        timeoutMs,
      });
    } finally {
      await browser.close().catch(() => {});
    }
  }, {
    label: 'oauth-auto',
    lane: 'maintenance',
    priority: 10,
  });
}

module.exports = {
  authorizeOAuthInBrowser,
};
