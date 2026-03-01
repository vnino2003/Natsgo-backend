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
function cleanTime(v) {
  // expects "HH:MM" or "HH:MM:SS"
  const s = cleanStr(v);
  if (!s) return "";
  // very light validation: 2 digits : 2 digits (: 2 digits optional)
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(s)) return "";
  return s.length === 5 ? `${s}:00` : s; // normalize to HH:MM:SS
}
function timeToMinutes(t) {
  // t = "HH:MM:SS"
  const [hh, mm] = String(t).split(":").map((x) => Number(x));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return NaN;
  return hh * 60 + mm;
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
        t.available_from,
        t.available_to,
        COUNT(bts.device_id) AS bus_count
      FROM terminals t
      LEFT JOIN bus_terminal_state bts
        ON bts.current_terminal_id = t.terminal_id
       AND bts.at_terminal = 1
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
        available_from: r.available_from, // "HH:MM:SS"
        available_to: r.available_to,     // "HH:MM:SS"
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

// GET /api/admin/terminals?q=
async function getAdminTerminals(req, res) {
  const q = cleanStr(req.query.q).toLowerCase();

  try {
    const where = [];
    const params = [];

    if (q) {
      where.push(
        "(LOWER(t.terminal_name) LIKE ? OR LOWER(t.city) LIKE ? OR CAST(t.terminal_id AS CHAR) LIKE ?)"
      );
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    const sql = `
      SELECT
        t.terminal_id,
        t.terminal_name,
        t.city,
        t.lat,
        t.lng,
        t.available_from,
        t.available_to,
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
        available_from: r.available_from,
        available_to: r.available_to,
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
        t.available_from,
        t.available_to,
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
      available_from: r.available_from,
      available_to: r.available_to,
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

  // NEW
  const available_from = cleanTime(req.body.available_from) || "05:00:00";
  const available_to = cleanTime(req.body.available_to) || "22:00:00";

  if (!terminal_name) return res.status(400).json({ message: "terminal_name is required" });
  if (!city) return res.status(400).json({ message: "city is required" });
  if (lat == null || lat < -90 || lat > 90) return res.status(400).json({ message: "lat must be -90 to 90" });
  if (lng == null || lng < -180 || lng > 180) return res.status(400).json({ message: "lng must be -180 to 180" });

  const fromMin = timeToMinutes(available_from);
  const toMin = timeToMinutes(available_to);
  if (!Number.isFinite(fromMin) || !Number.isFinite(toMin)) {
    return res.status(400).json({ message: "available_from / available_to must be valid time (HH:MM)" });
  }
  if (fromMin >= toMin) {
    return res.status(400).json({ message: "Available time invalid: 'from' must be earlier than 'to'." });
  }

  try {
    // ENFORCE MAX 2
    const [cntRows] = await db.execute(`SELECT COUNT(*) AS c FROM terminals`);
    const count = Number(cntRows?.[0]?.c ?? 0);
    if (count >= 2) {
      return res.status(409).json({ message: "Max terminals reached (2). Delete one before adding." });
    }

    const [ins] = await db.execute(
      `
      INSERT INTO terminals (terminal_name, city, lat, lng, available_from, available_to)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [terminal_name, city, lat, lng, available_from, available_to]
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

  // NEW
  const available_from = req.body.available_from != null ? cleanTime(req.body.available_from) : null;
  const available_to = req.body.available_to != null ? cleanTime(req.body.available_to) : null;

  if (lat != null && (lat < -90 || lat > 90)) return res.status(400).json({ message: "lat must be -90 to 90" });
  if (lng != null && (lng < -180 || lng > 180)) return res.status(400).json({ message: "lng must be -180 to 180" });

  if (terminal_name !== null && !terminal_name) return res.status(400).json({ message: "terminal_name cannot be empty" });
  if (city !== null && !city) return res.status(400).json({ message: "city cannot be empty" });

  if (available_from !== null && !available_from) {
    return res.status(400).json({ message: "available_from must be valid time (HH:MM)" });
  }
  if (available_to !== null && !available_to) {
    return res.status(400).json({ message: "available_to must be valid time (HH:MM)" });
  }

  // validate range if both provided (or fetch current if only one provided)
  try {
    let finalFrom = available_from;
    let finalTo = available_to;

    if (finalFrom === null || finalTo === null) {
      const [cur] = await db.execute(
        `SELECT available_from, available_to FROM terminals WHERE terminal_id = ? LIMIT 1`,
        [id]
      );
      if (!cur[0]) return res.status(404).json({ message: "Terminal not found" });
      if (finalFrom === null) finalFrom = cur[0].available_from;
      if (finalTo === null) finalTo = cur[0].available_to;
    }

    const fromMin = timeToMinutes(finalFrom);
    const toMin = timeToMinutes(finalTo);
    if (fromMin >= toMin) {
      return res.status(400).json({ message: "Available time invalid: 'from' must be earlier than 'to'." });
    }

    const [upd] = await db.execute(
      `
      UPDATE terminals
      SET
        terminal_name = COALESCE(?, terminal_name),
        city = COALESCE(?, city),
        lat = COALESCE(?, lat),
        lng = COALESCE(?, lng),
        available_from = COALESCE(?, available_from),
        available_to = COALESCE(?, available_to)
      WHERE terminal_id = ?
      `,
      [terminal_name, city, lat, lng, available_from, available_to, id]
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