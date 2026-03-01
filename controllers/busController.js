// controllers/busController.js
const db = require("../db");

const DEVICE_ONLINE_SECONDS = 120;

function toInt(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
function cleanStr(v) {
  return String(v ?? "").trim();
}

/* ------------------ helpers ------------------ */
async function generateBusCode(conn) {
  const [rows] = await conn.execute("SELECT bus_code FROM buses ORDER BY id DESC LIMIT 1");
  let next = 1;
  if (rows[0]?.bus_code) {
    const m = String(rows[0].bus_code).match(/BUS-(\d+)/i);
    if (m) next = Number(m[1]) + 1;
  }
  return `BUS-${String(next).padStart(3, "0")}`;
}

function makeRouteLabel(ts) {
  const cur = ts?.current_terminal_name;
  const tgt = ts?.target_terminal_name;
  if (!cur && !tgt) return null;
  if (cur && tgt) return `${cur} → ${tgt}`;
  if (cur && !tgt) return `${cur} → —`;
  return `— → ${tgt}`;
}

function mapRow(r) {
  const cap = Number(r.capacity ?? 0);
  const pc = Number(r.passenger_count ?? 0);
  const occPct = cap > 0 ? Math.round((pc / cap) * 100) : null;

  const terminalState =
    r.device_id
      ? {
          at_terminal: Number(r.at_terminal) === 1 ? 1 : 0,
          current_terminal_id: r.current_terminal_id ?? null,
          current_terminal_name: r.current_terminal_name || null,
          target_terminal_id: r.target_terminal_id ?? null,
          target_terminal_name: r.target_terminal_name || null,
          dist_m: r.dist_m != null ? Number(r.dist_m) : null,
          last_seen_at: r.terminal_last_seen_at ?? null,
          updated_at: r.terminal_updated_at ?? null,
        }
      : null;

  return {
    id: r.id,
    bus_code: r.bus_code,
    plate_no: r.plate_no,
    capacity: r.capacity,

    device_status: r.device_id ? "assigned" : "unassigned",
    device_online: r.device_id ? !!r.is_device_online : false,
    device_last_seen_at: r.device_last_seen_at ?? null,

    passenger_count: r.device_id ? pc : null,
    occupancy_percent: r.device_id ? occPct : null,

    terminal_state: terminalState,
    route_label: makeRouteLabel(terminalState),

    device: r.device_id
      ? {
          id: r.device_id,
          device_code: r.device_code,
          esp32_id: r.esp32_id,
          gps_enabled: Number(r.gps_enabled) === 1,
          last_seen_at: r.device_last_seen_at,
        }
      : null,

    ir: r.device_id
      ? {
          passenger_count: pc,
          in_total: Number(r.in_total ?? 0),
          out_total: Number(r.out_total ?? 0),
          last_event: r.last_event ?? "none",
          last_event_at: r.last_event_at ?? null,
          updated_at: r.ir_updated_at ?? null,
        }
      : null,

    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? null,
  };
}

/* =========================================================
   GET /api/admin/buses
========================================================= */
async function getBuses(req, res) {
  const q = cleanStr(req.query.q).toLowerCase();

  try {
    const where = [];
    const params = [];

    if (q) {
      where.push(
        "(LOWER(b.bus_code) LIKE ? OR LOWER(b.plate_no) LIKE ? OR LOWER(d.device_code) LIKE ? OR LOWER(d.esp32_id) LIKE ?)"
      );
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }

    const sql = `
      SELECT
        b.id,
        b.bus_code,
        b.plate_no,
        b.capacity,
        b.device_id,
        b.created_at,
        b.updated_at,

        d.device_code AS device_code,
        d.esp32_id AS esp32_id,
        d.gps_enabled AS gps_enabled,
        d.last_seen_at AS device_last_seen_at,
        (d.last_seen_at IS NOT NULL AND d.last_seen_at >= (NOW() - INTERVAL ${DEVICE_ONLINE_SECONDS} SECOND)) AS is_device_online,

        irs.passenger_count AS passenger_count,
        irs.in_total AS in_total,
        irs.out_total AS out_total,
        irs.last_event AS last_event,
        irs.last_event_at AS last_event_at,
        irs.updated_at AS ir_updated_at,

        bts.at_terminal,
        bts.current_terminal_id,
        ct.terminal_name AS current_terminal_name,
        bts.target_terminal_id,
        tt.terminal_name AS target_terminal_name,
        bts.dist_m,
        bts.last_seen_at AS terminal_last_seen_at,
        bts.updated_at AS terminal_updated_at

      FROM buses b
      LEFT JOIN iot_devices d ON d.id = b.device_id
      LEFT JOIN ir_status irs ON irs.device_id = b.device_id
      LEFT JOIN bus_terminal_state bts ON bts.device_id = b.device_id
      LEFT JOIN terminals ct ON ct.terminal_id = bts.current_terminal_id
      LEFT JOIN terminals tt ON tt.terminal_id = bts.target_terminal_id

      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY b.id DESC
    `;

    const [rows] = await db.execute(sql, params);
    return res.json(rows.map(mapRow));
  } catch (err) {
    console.error("getBuses error:", err);
    return res.status(500).json({ message: "Failed to fetch buses", error: err.message });
  }
}

/* =========================================================
   GET /api/admin/buses/:id
========================================================= */
async function getBusById(req, res) {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid bus id" });

  try {
    const [rows] = await db.execute(
      `
      SELECT *
      FROM buses
      WHERE id = ?
      LIMIT 1
      `,
      [id]
    );

    if (!rows[0]) return res.status(404).json({ message: "Bus not found" });

    return res.json(rows[0]);
  } catch (err) {
    console.error("getBusById error:", err);
    return res.status(500).json({ message: "Failed to fetch bus", error: err.message });
  }
}

/* =========================================================
   POST /api/admin/buses
========================================================= */
async function createBus(req, res) {
  const plate_no = cleanStr(req.body.plate_no);
  const capacity = toInt(req.body.capacity);

  if (!plate_no) return res.status(400).json({ message: "plate_no is required" });
  if (!capacity || capacity <= 0) return res.status(400).json({ message: "capacity must be > 0" });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const bus_code = await generateBusCode(conn);

    const [ins] = await conn.execute(
      `INSERT INTO buses (bus_code, plate_no, capacity, device_id)
       VALUES (?, ?, ?, NULL)`,
      [bus_code, plate_no, capacity]
    );

    await conn.commit();
    return res.status(201).json({ message: "Bus created", id: ins.insertId, bus_code });
  } catch (err) {
    await conn.rollback();
    console.error("createBus error:", err);
    return res.status(500).json({ message: "Failed to create bus", error: err.message });
  } finally {
    conn.release();
  }
}

/* =========================================================
   PUT /api/admin/buses/:id
========================================================= */
async function updateBus(req, res) {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid bus id" });

  const plate_no = req.body.plate_no != null ? cleanStr(req.body.plate_no) : null;
  const capacity = req.body.capacity != null ? toInt(req.body.capacity) : null;

  if (capacity != null && capacity <= 0) {
    return res.status(400).json({ message: "capacity must be > 0" });
  }

  try {
    const [upd] = await db.execute(
      `
      UPDATE buses
      SET
        plate_no = COALESCE(?, plate_no),
        capacity = COALESCE(?, capacity)
      WHERE id = ?
      `,
      [plate_no, capacity, id]
    );

    if (upd.affectedRows === 0) return res.status(404).json({ message: "Bus not found" });
    return res.json({ message: "Bus updated" });
  } catch (err) {
    console.error("updateBus error:", err);
    return res.status(500).json({ message: "Failed to update bus", error: err.message });
  }
}

/* =========================================================
   DELETE /api/admin/buses/:id
========================================================= */
async function deleteBus(req, res) {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid bus id" });

  try {
    const [del] = await db.execute("DELETE FROM buses WHERE id = ?", [id]);
    if (del.affectedRows === 0) return res.status(404).json({ message: "Bus not found" });
    return res.json({ message: "Bus deleted" });
  } catch (err) {
    console.error("deleteBus error:", err);
    return res.status(500).json({ message: "Failed to delete bus" });
  }
}

module.exports = {
  getBuses,
  getBusById,
  createBus,
  updateBus,
  deleteBus,
};