const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const DEFAULT_LOOKBACK_MINUTES = 30;
const DEFAULT_GRACE_MINUTES = 2;
const DEFAULT_MAX_MESSAGES = 40;

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function getConfig() {
  return {
    enabled: parseBoolean(process.env.ACCOUNT_VERIFICATION_MAIL_ENABLED, true),
    host: String(process.env.ACCOUNT_VERIFICATION_MAIL_HOST || 'imap.gmail.com').trim(),
    port: Number.parseInt(process.env.ACCOUNT_VERIFICATION_MAIL_PORT || '993', 10) || 993,
    secure: parseBoolean(process.env.ACCOUNT_VERIFICATION_MAIL_SECURE, true),
    user: String(process.env.ACCOUNT_VERIFICATION_MAIL_USER || '').trim(),
    pass: String(process.env.ACCOUNT_VERIFICATION_MAIL_PASS || ''),
    mailbox: String(process.env.ACCOUNT_VERIFICATION_MAIL_MAILBOX || 'INBOX').trim() || 'INBOX',
    lookbackMinutes: Math.max(1, Number.parseInt(process.env.ACCOUNT_VERIFICATION_MAIL_LOOKBACK_MINUTES || String(DEFAULT_LOOKBACK_MINUTES), 10) || DEFAULT_LOOKBACK_MINUTES),
    graceMinutes: Math.max(0, Number.parseInt(process.env.ACCOUNT_VERIFICATION_MAIL_GRACE_MINUTES || String(DEFAULT_GRACE_MINUTES), 10) || DEFAULT_GRACE_MINUTES),
    maxMessages: Math.max(5, Math.min(200, Number.parseInt(process.env.ACCOUNT_VERIFICATION_MAIL_MAX_MESSAGES || String(DEFAULT_MAX_MESSAGES), 10) || DEFAULT_MAX_MESSAGES)),
  };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function buildSinceDate(config, startedAt = '') {
  const now = Date.now();
  const fallback = now - config.lookbackMinutes * 60 * 1000;
  const parsedStartedAt = Date.parse(String(startedAt || '').trim());
  if (!Number.isFinite(parsedStartedAt)) {
    return new Date(fallback);
  }

  const withGrace = parsedStartedAt - config.graceMinutes * 60 * 1000;
  return new Date(Math.max(fallback, Math.min(withGrace, now)));
}

function normalizeCode(value) {
  return String(value || '').replace(/\D/g, '');
}

function extractVerificationCode(text) {
  const source = String(text || '');
  const patterns = [
    /(?:verification|verify|login|sign[\s-]*in|security|one[\s-]*time|auth|code|验证码|登录|安全)[^\d]{0,80}(\d[\d\s-]{4,14}\d)/ig,
    /(\d[\d\s-]{4,14}\d)[^\d]{0,80}(?:verification|verify|login|sign[\s-]*in|security|one[\s-]*time|auth|code|验证码|登录|安全)/ig,
    /\b(\d{6})\b/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) {
      const code = normalizeCode(match[1]);
      if (code.length >= 6 && code.length <= 8) {
        return code;
      }
    }
  }

  return '';
}

function getHeaderText(headers) {
  if (!headers || typeof headers.forEach !== 'function') {
    return '';
  }

  const values = [];
  headers.forEach((value, key) => {
    if (/^(delivered-to|to|cc|from|subject|x-forwarded-to|envelope-to|reply-to)$/i.test(String(key))) {
      values.push(`${key}: ${value}`);
    }
  });
  return values.join('\n');
}

function isLikelyVerificationMessage(text) {
  return /(openai|chatgpt|验证码|verification|verify|login|sign[\s-]*in|security code|one[\s-]*time code)/i.test(String(text || ''));
}

async function getLatestVerificationCode({ accountEmail, startedAt = '' } = {}) {
  const normalizedAccountEmail = normalizeEmail(accountEmail);
  if (!normalizedAccountEmail) {
    const err = new Error('缺少交付账号邮箱');
    err.statusCode = 400;
    throw err;
  }

  const config = getConfig();
  if (!config.enabled || !config.user || !config.pass) {
    const err = new Error('验证码邮箱尚未配置');
    err.statusCode = 503;
    throw err;
  }

  const since = buildSinceDate(config, startedAt);
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    logger: false,
  });
  client.on('error', () => {});

  try {
    await client.connect();
    const lock = await client.getMailboxLock(config.mailbox);
    try {
      const uids = await client.search({ since }, { uid: true });
      const latestUids = uids.slice(-config.maxMessages).reverse();

      for (const uid of latestUids) {
        const message = await client.fetchOne(uid, {
          envelope: true,
          internalDate: true,
          source: true,
        }, { uid: true });
        if (!message?.source) {
          continue;
        }

        const parsed = await simpleParser(message.source);
        const raw = message.source.toString('utf8');
        const combined = [
          parsed.subject || '',
          parsed.from?.text || '',
          parsed.to?.text || '',
          parsed.cc?.text || '',
          getHeaderText(parsed.headers),
          parsed.text || '',
          parsed.html || '',
          raw,
        ].join('\n');
        const combinedLower = combined.toLowerCase();
        if (!combinedLower.includes(normalizedAccountEmail)) {
          continue;
        }
        if (!isLikelyVerificationMessage(combined)) {
          continue;
        }

        const code = extractVerificationCode(combined);
        if (!code) {
          continue;
        }

        const receivedAt = parsed.date || message.internalDate || message.envelope?.date || null;
        return {
          found: true,
          code,
          accountEmail: normalizedAccountEmail,
          receivedAt: receivedAt ? new Date(receivedAt).toISOString() : '',
          subject: parsed.subject || '',
          searchedSince: since.toISOString(),
        };
      }

      return {
        found: false,
        code: '',
        accountEmail: normalizedAccountEmail,
        receivedAt: '',
        subject: '',
        searchedSince: since.toISOString(),
        message: `暂时没有找到 ${normalizedAccountEmail} 的最新验证码，请稍后刷新。`,
      };
    } finally {
      lock.release();
    }
  } catch (err) {
    const isAuthError = err.authenticationFailed || err.serverResponseCode === 'AUTHENTICATIONFAILED';
    const message = isAuthError
      ? '读取验证码邮箱失败：Gmail 登录失败，请确认已开启 IMAP，并使用 Google 应用专用密码。'
      : `读取验证码邮箱失败：${err.message}`;
    const wrapped = new Error(message);
    wrapped.statusCode = err.statusCode || 502;
    throw wrapped;
  } finally {
    try {
      await client.logout();
    } catch (_) {}
  }
}

module.exports = {
  getLatestVerificationCode,
};
