#!/usr/bin/env node

const db = require('../db');

const DEFAULT_DAYS = 1;
const DEFAULT_STATUS = 'unused';
const DEFAULT_PLAN_TYPE = 'team_invite';
const CHUNK_SIZE = 200;

function getArgValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const inline = process.argv.find(arg => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }

  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function printHelp() {
  console.log(`
Usage:
  node scripts/delete-old-cdks.js [options]

Options:
  --days <number>          Delete CDKs created at least this many days ago. Default: 1
  --status <status>        Delete only this status. Default: unused
  --plan-type <type>       Delete only this plan type. Default: team_invite
  --dry-run                Show what would be deleted without changing the database.
  --sample-limit <number>  Number of matching rows to show. Default: 20
  --help                   Show this help text.

Examples:
  node scripts/delete-old-cdks.js --dry-run
  node scripts/delete-old-cdks.js --days=1 --status=unused --plan-type=team_invite
`.trim());
}

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizePositiveInteger(value, fallback, max = 200) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(parsed, max));
}

function buildWhere({ status, planType }) {
  const clauses = [
    `${secondsSinceSql('cdk_cards', 'created_at')} >= @olderThanSeconds`,
  ];

  if (status) {
    clauses.push('LOWER(COALESCE(cdk_cards.status, \'\')) = LOWER(@status)');
  }

  if (planType) {
    clauses.push('LOWER(COALESCE(cdk_cards.plan_type, \'\')) = LOWER(@planType)');
  }

  clauses.push(`NOT EXISTS (
    SELECT 1
    FROM cdk_tasks active_task
    WHERE active_task.cdk_id = cdk_cards.id
      AND UPPER(COALESCE(active_task.status, '')) IN ('PENDING', 'PROCESSING')
  )`);

  return clauses.join('\n    AND ');
}

function secondsSinceSql(alias, preferredColumn = 'created_at') {
  const prefix = alias ? `${alias}.` : '';
  const timestampSql = `COALESCE(
        NULLIF(${prefix}${preferredColumn}, ''),
        NULLIF(${prefix}created_at, ''),
        '1970-01-01 00:00:00'
      )`;

  return `
    CASE
      WHEN ${timestampSql} > datetime('now', '+1 hour')
        THEN (strftime('%s', 'now', 'localtime') - strftime('%s', ${timestampSql}))
      ELSE (strftime('%s', 'now') - strftime('%s', ${timestampSql}))
    END
  `;
}

function runChunked(ids, sql) {
  let changes = 0;
  for (let index = 0; index < ids.length; index += CHUNK_SIZE) {
    const chunk = ids.slice(index, index + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    changes += db.prepare(sql(placeholders)).run(...chunk).changes;
  }
  return changes;
}

function main() {
  if (hasFlag('help') || hasFlag('h')) {
    printHelp();
    return;
  }

  const days = normalizePositiveNumber(getArgValue('days', DEFAULT_DAYS), DEFAULT_DAYS);
  const olderThanSeconds = Math.round(days * 24 * 60 * 60);
  const status = String(getArgValue('status', DEFAULT_STATUS) || '').trim();
  const planType = String(getArgValue('plan-type', DEFAULT_PLAN_TYPE) || '').trim();
  const sampleLimit = normalizePositiveInteger(getArgValue('sample-limit', '20'), 20);
  const dryRun = hasFlag('dry-run');
  const whereSql = buildWhere({ status, planType });
  const params = { olderThanSeconds, status, planType, sampleLimit };

  const summary = db.prepare(`
    SELECT
      COUNT(*) AS matched,
      SUM(CASE WHEN COALESCE(source_order_no, '') = '' THEN 1 ELSE 0 END) AS noOrder,
      SUM(CASE WHEN COALESCE(source_order_no, '') != '' THEN 1 ELSE 0 END) AS fromOrder,
      MIN(created_at) AS oldestCreatedAt,
      MAX(created_at) AS newestCreatedAt
    FROM cdk_cards
    WHERE ${whereSql}
  `).get(params);

  const sample = db.prepare(`
    SELECT
      id,
      code,
      status,
      plan_type AS planType,
      buyer_email AS buyerEmail,
      assigned_email AS assignedEmail,
      source_order_no AS sourceOrderNo,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM cdk_cards
    WHERE ${whereSql}
    ORDER BY datetime(COALESCE(NULLIF(created_at, ''), updated_at)) ASC, id ASC
    LIMIT @sampleLimit
  `).all(params);

  const ids = db.prepare(`
    SELECT id
    FROM cdk_cards
    WHERE ${whereSql}
    ORDER BY id ASC
  `).all(params).map(row => Number(row.id)).filter(Boolean);

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      days,
      olderThanSeconds,
      status,
      planType,
      matchedCount: Number(summary?.matched || 0),
      noOrderCount: Number(summary?.noOrder || 0),
      fromOrderCount: Number(summary?.fromOrder || 0),
      oldestCreatedAt: summary?.oldestCreatedAt || '',
      newestCreatedAt: summary?.newestCreatedAt || '',
      sample,
    }, null, 2));
    return;
  }

  const remove = db.transaction(() => {
    const taskRefs = runChunked(ids, placeholders => `
      UPDATE cdk_tasks
      SET cdk_id = NULL
      WHERE cdk_id IN (${placeholders})
    `);

    const orderRefs = runChunked(ids, placeholders => `
      UPDATE cdk_orders
      SET cdk_id = NULL
      WHERE cdk_id IN (${placeholders})
    `);

    const orderItemRefs = runChunked(ids, placeholders => `
      UPDATE cdk_order_items
      SET cdk_id = NULL
      WHERE cdk_id IN (${placeholders})
    `);

    const deleted = runChunked(ids, placeholders => `
      DELETE FROM cdk_cards
      WHERE id IN (${placeholders})
    `);

    return { deleted, taskRefs, orderRefs, orderItemRefs };
  });

  const result = ids.length > 0
    ? remove()
    : { deleted: 0, taskRefs: 0, orderRefs: 0, orderItemRefs: 0 };

  console.log(JSON.stringify({
    dryRun: false,
    days,
    olderThanSeconds,
    status,
    planType,
    matchedCount: Number(summary?.matched || 0),
    noOrderCount: Number(summary?.noOrder || 0),
    fromOrderCount: Number(summary?.fromOrder || 0),
    oldestCreatedAt: summary?.oldestCreatedAt || '',
    newestCreatedAt: summary?.newestCreatedAt || '',
    ...result,
  }, null, 2));
}

try {
  main();
} catch (err) {
  console.error(`Failed to delete old CDKs: ${err.stack || err.message}`);
  process.exit(1);
}
