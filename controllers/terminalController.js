// controllers/terminalController.js
const db = require("../db");

function toInt(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
function toFloat(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function cleanStr(v) {
  return String(v ?? "").trim();
}
function toTinyBool(v, fallback = 1) {
  if (v === true || v === "true" || v === 1 || v === "1") return 1;
  if (v === false || v === "false" || v === 0 || v === "0") return 0;
  return fallback;
}

/* =========================================================
   PUBLIC (Commuter / Track)
   ========================================================= */

// GET /api/terminals
async function getPublicTerminals(req, res) {
  try {
    const [rows] = await db.execute(
      `
      SELECT
        t.terminal_id,
        t.terminal_name,
        t.city,
        t.lat,
        t.lng,
        t.is_active,
        COUNT(bts.device_id) AS bus_count
      FROM terminals t
      LEFT JOIN bus_terminal_state bts
        ON bts.current_terminal_id = t.terminal_id
       AND bts.at_terminal = 1
      WHERE t.is_active = 1
      GROUP BY t.terminal_id
      ORDER BY t.terminal_name ASC
      `
    );

    return res.json(
      rows.map((r) => ({
        terminal_id: r.terminal_id,
        terminal_name: r.terminal_name,
        city: r.city,
        lat: Number(r.lat),
        lng: Number(r.lng),
        is_active: Number(r.is_active) === 1,
        bus_count: Number(r.bus_count ?? 0),
      }))
    );
  } catch (err) {
    console.error("getPublicTerminals error:", err);
    return res.status(500).json({ message: "Failed to fetch terminals", error: err.message });
  }
}

/* =========================================================
   ADMIN CRUD
   ========================================================= */

// GET /api/admin/terminals?q=&active=1|0
async function getAdminTerminals(req, res) {
  const q = cleanStr(req.query.q).toLowerCase();
  const active = req.query.active != null ? cleanStr(req.query.active) : "";

  try {
    const where = [];
    const params = [];

    if (q) {
      where.push(
        "(LOWER(t.terminal_name) LIKE ? OR LOWER(t.city) LIKE ? OR CAST(t.terminal_id AS CHAR) LIKE ?)"
      );
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    if (active === "1" || active === "0") {
      where.push("t.is_active = ?");
      params.push(Number(active));
    }

    const sql = `
      SELECT
        t.terminal_id,
        t.terminal_name,
        t.city,
        t.lat,
        t.lng,
        t.is_active,
        t.created_at,
        t.updated_at,
        COUNT(bts.device_id) AS bus_count
      FROM terminals t
      LEFT JOIN bus_terminal_state bts
        ON bts.current_terminal_id = t.terminal_id
       AND bts.at_terminal = 1
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      GROUP BY t.terminal_id
      ORDER BY t.terminal_id DESC
    `;

    const [rows] = await db.execute(sql, params);

    return res.json(
      rows.map((r) => ({
        terminal_id: r.terminal_id,
        terminal_name: r.terminal_name,
        city: r.city,
        lat: Number(r.lat),
        lng: Number(r.lng),
        is_active: Number(r.is_active), // keep 0/1 for admin UI
        bus_count: Number(r.bus_count ?? 0),
        created_at: r.created_at ?? null,
        updated_at: r.updated_at ?? null,
      }))
    );
  } catch (err) {
    console.error("getAdminTerminals error:", err);
    return res.status(500).json({ message: "Failed to fetch terminals", error: err.message });
  }
}

// GET /api/admin/terminals/:id
async function getTerminalById(req, res) {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid terminal id" });

  try {
    const [rows] = await db.execute(
      `
      SELECT
        t.terminal_id,
        t.terminal_name,
        t.city,
        t.lat,
        t.lng,
        t.is_active,
        t.created_at,
        t.updated_at,
        COUNT(bts.device_id) AS bus_count
      FROM terminals t
      LEFT JOIN bus_terminal_state bts
        ON bts.current_terminal_id = t.terminal_id
       AND bts.at_terminal = 1
      WHERE t.terminal_id = ?
      GROUP BY t.terminal_id
      LIMIT 1
      `,
      [id]
    );

    if (!rows[0]) return res.status(404).json({ message: "Terminal not found" });

    const r = rows[0];
    return res.json({
      terminal_id: r.terminal_id,
      terminal_name: r.terminal_name,
      city: r.city,
      lat: Number(r.lat),
      lng: Number(r.lng),
      is_active: Number(r.is_active),
      bus_count: Number(r.bus_count ?? 0),
      created_at: r.created_at ?? null,
      updated_at: r.updated_at ?? null,
    });
  } catch (err) {
    console.error("getTerminalById error:", err);
    return res.status(500).json({ message: "Failed to fetch terminal", error: err.message });
  }
}

// POST /api/admin/terminals
async function createTerminal(req, res) {
  const terminal_name = cleanStr(req.body.terminal_name);
  const city = cleanStr(req.body.city);
  const lat = toFloat(req.body.lat);
  const lng = toFloat(req.body.lng);
  const is_active = toTinyBool(req.body.is_active, 1);

  if (!terminal_name) return res.status(400).json({ message: "terminal_name is required" });
  if (!city) return res.status(400).json({ message: "city is required" });
  if (lat == null || lat < -90 || lat > 90) return res.status(400).json({ message: "lat must be -90 to 90" });
  if (lng == null || lng < -180 || lng > 180) return res.status(400).json({ message: "lng must be -180 to 180" });

  try {
    const [ins] = await db.execute(
      `
      INSERT INTO terminals (terminal_name, city, lat, lng, is_active)
      VALUES (?, ?, ?, ?, ?)
      `,
      [terminal_name, city, lat, lng, is_active]
    );

    return res.status(201).json({ message: "Terminal created", terminal_id: ins.insertId });
  } catch (err) {
    console.error("createTerminal error:", err);
    return res.status(500).json({ message: "Failed to create terminal", error: err.message });
  }
}

// PUT /api/admin/terminals/:id
async function updateTerminal(req, res) {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid terminal id" });

  const terminal_name = req.body.terminal_name != null ? cleanStr(req.body.terminal_name) : null;
  const city = req.body.city != null ? cleanStr(req.body.city) : null;
  const lat = req.body.lat != null ? toFloat(req.body.lat) : null;
  const lng = req.body.lng != null ? toFloat(req.body.lng) : null;
  const is_active = req.body.is_active != null ? toTinyBool(req.body.is_active) : null;

  if (lat != null && (lat < -90 || lat > 90)) return res.status(400).json({ message: "lat must be -90 to 90" });
  if (lng != null && (lng < -180 || lng > 180)) return res.status(400).json({ message: "lng must be -180 to 180" });

  if (terminal_name !== null && !terminal_name) return res.status(400).json({ message: "terminal_name cannot be empty" });
  if (city !== null && !city) return res.status(400).json({ message: "city cannot be empty" });

  try {
    const [upd] = await db.execute(
      `
      UPDATE terminals
      SET
        terminal_name = COALESCE(?, terminal_name),
        city = COALESCE(?, city),
        lat = COALESCE(?, lat),
        lng = COALESCE(?, lng),
        is_active = COALESCE(?, is_active)
      WHERE terminal_id = ?
      `,
      [terminal_name, city, lat, lng, is_active, id]
    );

    if (upd.affectedRows === 0) return res.status(404).json({ message: "Terminal not found" });
    return res.json({ message: "Terminal updated" });
  } catch (err) {
    console.error("updateTerminal error:", err);
    return res.status(500).json({ message: "Failed to update terminal", error: err.message });
  }
}

// DELETE /api/admin/terminals/:id
async function deleteTerminal(req, res) {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid terminal id" });

  try {
    const [del] = await db.execute("DELETE FROM terminals WHERE terminal_id = ?", [id]);
    if (del.affectedRows === 0) return res.status(404).json({ message: "Terminal not found" });
    return res.json({ message: "Terminal deleted" });
  } catch (err) {
    console.error("deleteTerminal error:", err);
    return res.status(500).json({ message: "Failed to delete terminal", error: err.message });
  }
}

module.exports = {
  getPublicTerminals,
  getAdminTerminals,
  getTerminalById,
  createTerminal,
  updateTerminal,
  deleteTerminal,
};
