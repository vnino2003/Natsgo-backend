// controllers/routeController.js
const db = require("../db");

function toInt(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
function cleanStr(v) {
  return String(v ?? "").trim();
}
function cleanColor(v) {
  const s = cleanStr(v);
  if (!s) return "";
  // allow hex like #06b6d4
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  return "";
}
function pairKeyFrom(aId, bId) {
  const a = Number(aId);
  const b = Number(bId);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return { lo, hi, key: `${lo}_${hi}` };
}
function parsePoints(input) {
  // input can be array already, or JSON string
  let pts = input;
  if (typeof input === "string") {
    try { pts = JSON.parse(input); } catch { pts = null; }
  }
  if (!Array.isArray(pts)) return null;

  const out = [];
  for (const p of pts) {
    const lat = Number(p?.lat);
    const lng = Number(p?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    out.push({ lat, lng });
  }
  return out;
}

/* =========================================================
   PUBLIC
   ========================================================= */

// GET /api/routes (public)  -> returns route for the only pair (if exists)
async function getPublicRoute(req, res) {
  try {
    // because you only allow 2 terminals, the pair is deterministic
    const [terms] = await db.execute(`SELECT terminal_id FROM terminals ORDER BY terminal_id ASC LIMIT 2`);
    if ((terms?.length || 0) < 2) return res.json(null);

    const a = Number(terms[0].terminal_id);
    const b = Number(terms[1].terminal_id);
    const { key } = pairKeyFrom(a, b);

    const [rows] = await db.execute(
      `
      SELECT route_id, a_terminal_id, b_terminal_id, pair_key, name, color, points_json, method, recorded_bus_id, updated_at
      FROM routes
      WHERE pair_key = ?
      LIMIT 1
      `,
      [key]
    );

    if (!rows[0]) return res.json(null);

    const r = rows[0];
    return res.json({
      route_id: r.route_id,
      a_terminal_id: r.a_terminal_id,
      b_terminal_id: r.b_terminal_id,
      pair_key: r.pair_key,
      name: r.name,
      color: r.color,
      points: Array.isArray(r.points_json) ? r.points_json : (r.points_json ? JSON.parse(JSON.stringify(r.points_json)) : []),
      method: r.method,
      recorded_bus_id: r.recorded_bus_id ?? null,
      updated_at: r.updated_at ?? null,
    });
  } catch (err) {
    console.error("getPublicRoute error:", err);
    return res.status(500).json({ message: "Failed to fetch route", error: err.message });
  }
}

/* =========================================================
   ADMIN
   ========================================================= */

// GET /api/admin/routes?q=
async function getAdminRoutes(req, res) {
  const q = cleanStr(req.query.q).toLowerCase();

  try {
    const where = [];
    const params = [];

    if (q) {
      where.push(`(LOWER(r.name) LIKE ? OR LOWER(r.pair_key) LIKE ? OR CAST(r.route_id AS CHAR) LIKE ?)`);
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    const [rows] = await db.execute(
      `
      SELECT
        r.route_id, r.a_terminal_id, r.b_terminal_id, r.pair_key,
        r.name, r.color, r.points_json, r.method, r.recorded_bus_id,
        r.created_at, r.updated_at
      FROM routes r
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY r.route_id DESC
      `,
      params
    );

    return res.json(
      rows.map((r) => ({
        route_id: r.route_id,
        a_terminal_id: r.a_terminal_id,
        b_terminal_id: r.b_terminal_id,
        pair_key: r.pair_key,
        name: r.name,
        color: r.color,
        points: Array.isArray(r.points_json) ? r.points_json : (r.points_json ? JSON.parse(JSON.stringify(r.points_json)) : []),
        method: r.method,
        recorded_bus_id: r.recorded_bus_id ?? null,
        created_at: r.created_at ?? null,
        updated_at: r.updated_at ?? null,
      }))
    );
  } catch (err) {
    console.error("getAdminRoutes error:", err);
    return res.status(500).json({ message: "Failed to fetch routes", error: err.message });
  }
}

// GET /api/admin/routes/:id
async function getRouteById(req, res) {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid route id" });

  try {
    const [rows] = await db.execute(
      `
      SELECT route_id, a_terminal_id, b_terminal_id, pair_key, name, color, points_json, method, recorded_bus_id, created_at, updated_at
      FROM routes
      WHERE route_id = ?
      LIMIT 1
      `,
      [id]
    );

    if (!rows[0]) return res.status(404).json({ message: "Route not found" });

    const r = rows[0];
    return res.json({
      route_id: r.route_id,
      a_terminal_id: r.a_terminal_id,
      b_terminal_id: r.b_terminal_id,
      pair_key: r.pair_key,
      name: r.name,
      color: r.color,
      points: Array.isArray(r.points_json) ? r.points_json : (r.points_json ? JSON.parse(JSON.stringify(r.points_json)) : []),
      method: r.method,
      recorded_bus_id: r.recorded_bus_id ?? null,
      created_at: r.created_at ?? null,
      updated_at: r.updated_at ?? null,
    });
  } catch (err) {
    console.error("getRouteById error:", err);
    return res.status(500).json({ message: "Failed to fetch route", error: err.message });
  }
}

// POST /api/admin/routes
// Creates ONE route for a pair (A↔B). If pair already exists, return 409.
async function createRoute(req, res) {
  const a_terminal_id = toInt(req.body.a_terminal_id);
  const b_terminal_id = toInt(req.body.b_terminal_id);

  if (!a_terminal_id || !b_terminal_id) return res.status(400).json({ message: "a_terminal_id and b_terminal_id are required" });
  if (a_terminal_id === b_terminal_id) return res.status(400).json({ message: "Terminals must be different" });

  const { lo, hi, key } = pairKeyFrom(a_terminal_id, b_terminal_id);

  const name = cleanStr(req.body.name) || "Route A ↔ B";
  const color = cleanColor(req.body.color) || "#06b6d4";
  const method = ["manual", "record", "unknown"].includes(req.body.method) ? req.body.method : "unknown";
  const recorded_bus_id = cleanStr(req.body.recorded_bus_id) || null;

  const points = parsePoints(req.body.points ?? []);
  if (!points) return res.status(400).json({ message: "points must be an array of {lat,lng}" });

  try {
    // terminals exist?
    const [tRows] = await db.execute(
      `SELECT terminal_id FROM terminals WHERE terminal_id IN (?, ?)`,
      [lo, hi]
    );
    if ((tRows?.length || 0) < 2) return res.status(400).json({ message: "Terminal IDs not found" });

    // unique pair
    const [exists] = await db.execute(`SELECT route_id FROM routes WHERE pair_key = ? LIMIT 1`, [key]);
    if (exists[0]) return res.status(409).json({ message: "Route for this pair already exists." });

    const [ins] = await db.execute(
      `
      INSERT INTO routes (a_terminal_id, b_terminal_id, pair_key, name, color, points_json, method, recorded_bus_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [lo, hi, key, name, color, JSON.stringify(points), method, recorded_bus_id]
    );

    return res.status(201).json({ message: "Route created", route_id: ins.insertId, pair_key: key });
  } catch (err) {
    console.error("createRoute error:", err);
    return res.status(500).json({ message: "Failed to create route", error: err.message });
  }
}

// PUT /api/admin/routes/:id
async function updateRoute(req, res) {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid route id" });

  const name = req.body.name != null ? cleanStr(req.body.name) : null;
  const color = req.body.color != null ? cleanColor(req.body.color) : null;
  const method = req.body.method != null ? (["manual", "record", "unknown"].includes(req.body.method) ? req.body.method : "") : null;
  const recorded_bus_id = req.body.recorded_bus_id != null ? (cleanStr(req.body.recorded_bus_id) || null) : null;

  if (name !== null && !name) return res.status(400).json({ message: "name cannot be empty" });
  if (color !== null && !color) return res.status(400).json({ message: "color must be hex like #06b6d4" });
  if (method !== null && !method) return res.status(400).json({ message: "method must be manual|record|unknown" });

  const points = req.body.points != null ? parsePoints(req.body.points) : null;
  if (req.body.points != null && !points) return res.status(400).json({ message: "points must be an array of {lat,lng}" });

  try {
    const [cur] = await db.execute(`SELECT route_id FROM routes WHERE route_id = ? LIMIT 1`, [id]);
    if (!cur[0]) return res.status(404).json({ message: "Route not found" });

    const [upd] = await db.execute(
      `
      UPDATE routes
      SET
        name = COALESCE(?, name),
        color = COALESCE(?, color),
        points_json = COALESCE(?, points_json),
        method = COALESCE(?, method),
        recorded_bus_id = COALESCE(?, recorded_bus_id)
      WHERE route_id = ?
      `,
      [
        name,
        color,
        points ? JSON.stringify(points) : null,
        method,
        recorded_bus_id,
        id,
      ]
    );

    if (upd.affectedRows === 0) return res.status(404).json({ message: "Route not found" });
    return res.json({ message: "Route updated" });
  } catch (err) {
    console.error("updateRoute error:", err);
    return res.status(500).json({ message: "Failed to update route", error: err.message });
  }
}

// DELETE /api/admin/routes/:id
async function deleteRoute(req, res) {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid route id" });

  try {
    const [del] = await db.execute(`DELETE FROM routes WHERE route_id = ?`, [id]);
    if (del.affectedRows === 0) return res.status(404).json({ message: "Route not found" });
    return res.json({ message: "Route deleted" });
  } catch (err) {
    console.error("deleteRoute error:", err);
    return res.status(500).json({ message: "Failed to delete route", error: err.message });
  }
}

module.exports = {
  getPublicRoute,
  getAdminRoutes,
  getRouteById,
  createRoute,
  updateRoute,
  deleteRoute,
};