#!/usr/bin/env node

const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'db'));

const hasOwn = (key) => Object.prototype.hasOwnProperty.call(process.env, key);

const updates = [];
if (hasOwn('ADMIN_BASIC_AUTH_ENABLED')) {
  updates.push(['admin_basic_auth_enabled', process.env.ADMIN_BASIC_AUTH_ENABLED || 'false']);
}
if (hasOwn('ADMIN_BASIC_AUTH_USER')) {
  updates.push(['admin_basic_auth_user', process.env.ADMIN_BASIC_AUTH_USER || '']);
}
if (hasOwn('ADMIN_BASIC_AUTH_PASS')) {
  updates.push(['admin_basic_auth_pass', process.env.ADMIN_BASIC_AUTH_PASS || '']);
}

if (updates.length === 0) {
  console.error('No admin auth env vars provided.');
  console.error('Use ADMIN_BASIC_AUTH_ENABLED, ADMIN_BASIC_AUTH_USER, ADMIN_BASIC_AUTH_PASS.');
  process.exit(1);
}

const writeSetting = db.prepare(`
  INSERT INTO settings (key, value)
  VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

const save = db.transaction(() => {
  for (const [key, value] of updates) {
    writeSetting.run(key, value);
  }
});

save();

const configured = Object.fromEntries(updates.map(([key, value]) => [
  key,
  key.endsWith('_pass') ? '***REDACTED***' : value,
]));

console.log(JSON.stringify(configured, null, 2));
