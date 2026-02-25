// services/notificationHelper.js
const db = require("../db");

/**
 * Numeric enums (match your notifications table)
 */
const CATEGORY = Object.freeze({
  IOT: 1,
  BUS: 2,
  AUTH: 3,
  SYSTEM: 4,
  ADMIN: 5,
});

const SEVERITY = Object.freeze({
  INFO: 1,
  WARNING: 2,
  CRITICAL: 3,
});

const AUDIENCE = Object.freeze({
  ADMIN: 1,
  USER: 2,
  ALL: 3,
});

const ENTITY = Object.freeze({
  DEVICE: 1,
  BUS: 2,
  USER: 3,
  SYSTEM: 4,
});

function getExec(conn) {
  return conn && typeof conn.execute === "function" ? conn : db;
}

function normDedupeKeyNullable(v) {
  const s = String(v ?? "").trim();
  return s ? s : null; // ✅ NULL if empty
}

function normDedupeKeyRequired(v) {
  const s = String(v ?? "").trim();
  if (!s || s === "0") throw new Error("dedupe_key must be a non-empty unique string");
  return s;
}

async function createNotification(
  {
    category,
    type,
    title,
    message,

    severity = SEVERITY.INFO,
    audience = AUDIENCE.ADMIN,
    user_id = null,

    unread = 1,
    active = 0,
    resolved_at = null,

    entity_type = null,
    entity_id = null,

    dedupe_key = null,
    meta = null,

    conn = null,
  } = {}
) {
  if (!category || !type || !title || !message) {
    throw new Error("createNotification: category, type, title, message are required");
  }

  const execer = getExec(conn);
  const dk = normDedupeKeyNullable(dedupe_key);

  const [result] = await execer.execute(
    `
    INSERT INTO notifications
      (category, type, severity, audience, user_id,
       title, message,
       unread, active, resolved_at,
       entity_type, entity_id,
       dedupe_key, meta)
    VALUES
      (?, ?, ?, ?, ?,
       ?, ?,
       ?, ?, ?,
       ?, ?,
       ?, ?)
    `,
    [
      category,
      type,
      severity,
      audience,
      user_id,

      title,
      message,

      unread ? 1 : 0,
      active ? 1 : 0,
      resolved_at,

      entity_type,
      entity_id,

      dk, // ✅ NULL if not provided
      meta ? JSON.stringify(meta) : null,
    ]
  );

  return { id: result.insertId };
}

async function upsertActiveAlert(
  {
    dedupe_key,
    category,
    type,
    title,
    message,

    severity = SEVERITY.WARNING,
    audience = AUDIENCE.ADMIN,
    user_id = null,

    entity_type = null,
    entity_id = null,
    meta = null,

    conn = null,
  } = {}
) {
  const dk = normDedupeKeyRequired(dedupe_key);

  if (!category || !type || !title || !message) {
    throw new Error("upsertActiveAlert: category, type, title, message are required");
  }

  const execer = getExec(conn);

  const [result] = await execer.execute(
    `
    INSERT INTO notifications
      (category, type, severity, audience, user_id,
       title, message,
       unread, active, resolved_at,
       entity_type, entity_id,
       dedupe_key, meta)
    VALUES
      (?, ?, ?, ?, ?,
       ?, ?,
       1, 1, NULL,
       ?, ?,
       ?, ?)
    ON DUPLICATE KEY UPDATE
      category = VALUES(category),
      type = VALUES(type),
      severity = VALUES(severity),
      audience = VALUES(audience),
      user_id = VALUES(user_id),
      title = VALUES(title),
      message = VALUES(message),
      unread = 1,
      active = 1,
      resolved_at = NULL,
      entity_type = VALUES(entity_type),
      entity_id = VALUES(entity_id),
      meta = VALUES(meta),
      updated_at = NOW()
    `,
    [
      category,
      type,
      severity,
      audience,
      user_id,

      title,
      message,

      entity_type,
      entity_id,

      dk, // ✅ guaranteed non-empty string
      meta ? JSON.stringify(meta) : null,
    ]
  );

  return { ok: true, dedupe_key: dk, insertId: result.insertId || null };
}

async function resolveActiveAlert(dedupe_key, { conn = null } = {}) {
  const dk = normDedupeKeyRequired(dedupe_key);

  const execer = getExec(conn);

  const [res] = await execer.execute(
    `
    UPDATE notifications
    SET active = 0,
        resolved_at = NOW(),
        updated_at = NOW()
    WHERE dedupe_key = ? AND active = 1
    `,
    [dk]
  );

  return { ok: true, affected: res.affectedRows };
}

module.exports = {
  CATEGORY,
  SEVERITY,
  AUDIENCE,
  ENTITY,

  createNotification,
  upsertActiveAlert,
  resolveActiveAlert,
};