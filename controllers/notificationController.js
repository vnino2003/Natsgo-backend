// controllers/notificationController.js
const db = require("../db");
const { CATEGORY, SEVERITY, AUDIENCE, ENTITY } = require("../services/notificationHelper");

/* =========================================================
   Utilities
========================================================= */

function toInt(v, def = null) {
  if (v === undefined || v === null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function toBool01(v, def = null) {
  if (v === undefined || v === null || v === "") return def;
  if (v === "1" || v === 1 || v === true || v === "true") return 1;
  if (v === "0" || v === 0 || v === false || v === "false") return 0;
  return def;
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/* =========================================================
   GET ALL NOTIFICATIONS
   GET /api/admin/notifications
========================================================= */
async function getAllNotifications(req, res) {
  try {
    const q = String(req.query.q || "").trim();

    const category = toInt(req.query.category);
    const severity = toInt(req.query.severity);
    const audience = toInt(req.query.audience);
    const user_id = toInt(req.query.user_id);
    const entity_type = toInt(req.query.entity_type);
    const entity_id = toInt(req.query.entity_id);

    const unread = toBool01(req.query.unread);
    const active = toBool01(req.query.active);

    // 🔥 SAFE LIMIT/OFFSET (NO placeholders)
    const limitRaw = Number(req.query.limit ?? 50);
    const offsetRaw = Number(req.query.offset ?? 0);

    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
      : 50;

    const offset = Number.isFinite(offsetRaw)
      ? Math.max(Math.trunc(offsetRaw), 0)
      : 0;

    const where = [];
    const params = [];

    if (q) {
      where.push(`(n.title LIKE ? OR n.message LIKE ? OR n.type LIKE ? OR n.dedupe_key LIKE ?)`);
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }

    if (category !== null) {
      where.push(`n.category = ?`);
      params.push(category);
    }

    if (severity !== null) {
      where.push(`n.severity = ?`);
      params.push(severity);
    }

    if (audience !== null) {
      where.push(`n.audience = ?`);
      params.push(audience);
    }

    if (user_id !== null) {
      where.push(`n.user_id = ?`);
      params.push(user_id);
    }

    if (entity_type !== null) {
      where.push(`n.entity_type = ?`);
      params.push(entity_type);
    }

    if (entity_id !== null) {
      where.push(`n.entity_id = ?`);
      params.push(entity_id);
    }

    if (unread !== null) {
      where.push(`n.unread = ?`);
      params.push(unread);
    }

    if (active !== null) {
      where.push(`n.active = ?`);
      params.push(active);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    /* -------- COUNT -------- */
    const [countRows] = await db.execute(
      `SELECT COUNT(*) AS total FROM notifications n ${whereSql}`,
      params
    );

    const total = countRows?.[0]?.total ?? 0;

    /* -------- DATA -------- */
    const sql = `
      SELECT
        n.id, n.category, n.type, n.severity, n.audience, n.user_id,
        n.title, n.message, n.unread, n.active, n.resolved_at,
        n.entity_type, n.entity_id, n.dedupe_key, n.meta,
        n.created_at, n.updated_at
      FROM notifications n
      ${whereSql}
      ORDER BY
        n.active DESC,
        n.severity DESC,
        n.updated_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [rows] = await db.execute(sql, params);

    const data = rows.map((r) => ({
      ...r,
      unread: Number(r.unread) === 1,
      active: Number(r.active) === 1,
      meta: r.meta ? safeJsonParse(r.meta) : null,
    }));

    return res.json({
      ok: true,
      total,
      limit,
      offset,
      data,
      enums: { CATEGORY, SEVERITY, AUDIENCE, ENTITY },
    });
  } catch (err) {
    console.error("getAllNotifications error:", err);
    return res.status(500).json({ ok: false, message: "Failed to fetch notifications" });
  }
}

/* =========================================================
   SUMMARY
   GET /api/admin/notifications/summary
========================================================= */
async function getNotificationSummary(req, res) {
  try {
    const [rows] = await db.execute(`
      SELECT
        COUNT(*) AS total,
        SUM(active = 1) AS active,
        SUM(unread = 1) AS unread,
        SUM(severity = 3) AS critical,
        SUM(active = 1 AND severity = 3) AS critical_active
      FROM notifications
    `);

    const s = rows?.[0] || {};

    return res.json({
      ok: true,
      summary: {
        total: Number(s.total || 0),
        active: Number(s.active || 0),
        unread: Number(s.unread || 0),
        critical: Number(s.critical || 0),
        critical_active: Number(s.critical_active || 0),
      },
    });
  } catch (err) {
    console.error("getNotificationSummary error:", err);
    return res.status(500).json({ ok: false, message: "Failed to fetch summary" });
  }
}

/* =========================================================
   MARK READ / UNREAD
   PATCH /api/admin/notifications/:id/read
========================================================= */
async function setNotificationRead(req, res) {
  try {
    const id = Number(req.params.id);
    const unread = toBool01(req.body?.unread, 0);

    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, message: "Invalid id" });
    }

    const [r] = await db.execute(
      `UPDATE notifications
       SET unread = ?, updated_at = NOW()
       WHERE id = ?`,
      [unread, id]
    );

    return res.json({ ok: true, affected: r.affectedRows });
  } catch (err) {
    console.error("setNotificationRead error:", err);
    return res.status(500).json({ ok: false, message: "Failed to update notification" });
  }
}

/* =========================================================
   RESOLVE NOTIFICATION
   PATCH /api/admin/notifications/:id/resolve
========================================================= */
async function resolveNotification(req, res) {
  try {
    const id = Number(req.params.id);

    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, message: "Invalid id" });
    }

    const [r] = await db.execute(
      `
      UPDATE notifications
      SET active = 0,
          resolved_at = COALESCE(resolved_at, NOW()),
          updated_at = NOW()
      WHERE id = ?
      `,
      [id]
    );

    return res.json({ ok: true, affected: r.affectedRows });
  } catch (err) {
    console.error("resolveNotification error:", err);
    return res.status(500).json({ ok: false, message: "Failed to resolve notification" });
  }
}

/* =========================================================
   DELETE SINGLE NOTIFICATION
   DELETE /api/admin/notifications/:id
========================================================= */
async function deleteNotification(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, message: "Invalid id" });
    }

    const [r] = await db.execute(`DELETE FROM notifications WHERE id = ?`, [id]);
    return res.json({ ok: true, affected: r.affectedRows });
  } catch (err) {
    console.error("deleteNotification error:", err);
    return res.status(500).json({ ok: false, message: "Failed to delete notification" });
  }
}

async function getNotificationPreview(req, res) {
  try {
    const limitRaw = Number(req.query.limit ?? 5);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 10)
      : 5;

    const [rows] = await db.execute(
      `
      SELECT
        n.id, n.category, n.type, n.severity, n.audience, n.user_id,
        n.title, n.message, n.unread, n.active, n.resolved_at,
        n.entity_type, n.entity_id, n.dedupe_key, n.meta,
        n.created_at, n.updated_at
      FROM notifications n
      ORDER BY
        n.unread DESC,
        n.active DESC,
        n.severity DESC,
        n.updated_at DESC
      LIMIT ${limit}
      `
    );

    const data = rows.map((r) => ({
      ...r,
      unread: Number(r.unread) === 1,
      active: Number(r.active) === 1,
      meta: r.meta ? safeJsonParse(r.meta) : null,
    }));

    return res.json({ ok: true, limit, data });
  } catch (err) {
    console.error("getNotificationPreview error:", err);
    return res.status(500).json({ ok: false, message: "Failed to fetch preview" });
  }
}
/* =========================================================
   CLEAR NOTIFICATIONS (BULK DELETE)
   DELETE /api/admin/notifications
   Optional query:
     ?mode=all | resolved | read | resolved_read
     ?older_than_days=30
========================================================= */
async function clearNotifications(req, res) {
  try {
    const mode = String(req.query.mode || "resolved").toLowerCase();
    const olderDays = toInt(req.query.older_than_days);

    // default safe: only resolved
    const where = [];
    const params = [];

    if (mode === "all") {
      // no where
    } else if (mode === "resolved") {
      where.push("active = 0");
    } else if (mode === "read") {
      where.push("unread = 0");
    } else if (mode === "resolved_read") {
      where.push("active = 0");
      where.push("unread = 0");
    } else {
      return res.status(400).json({
        ok: false,
        message: "Invalid mode. Use all|resolved|read|resolved_read",
      });
    }

    if (olderDays !== null) {
      // delete only those older than X days based on updated_at / created_at
      where.push(`(COALESCE(updated_at, created_at) < DATE_SUB(NOW(), INTERVAL ? DAY))`);
      params.push(olderDays);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [r] = await db.execute(`DELETE FROM notifications ${whereSql}`, params);

    return res.json({
      ok: true,
      mode,
      older_than_days: olderDays,
      affected: r.affectedRows,
    });
  } catch (err) {
    console.error("clearNotifications error:", err);
    return res.status(500).json({ ok: false, message: "Failed to clear notifications" });
  }
}

/* ========================================================= */

module.exports = {
  getAllNotifications,
  getNotificationSummary,
  setNotificationRead,
    getNotificationPreview, // ✅ add
  resolveNotification,
  deleteNotification,
  clearNotifications,
};