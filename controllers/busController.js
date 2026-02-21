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

async function generateBusCode(conn) {
  const [rows] = await conn.execute("SELECT bus_code FROM buses ORDER BY id DESC LIMIT 1");
  let next = 1;
  if (rows[0]?.bus_code) {
    const m = String(rows[0].bus_code).match(/BUS-(\d+)/i);
    if (m) next = Number(m[1]) + 1;
  }
  return `BUS-${String(next).padStart(3, "0")}`;
}

// ✅ GET /api/admin/buses?q=&status=
async function getBuses(req, res) {
  const q = cleanStr(req.query.q).toLowerCase();
  const status = cleanStr(req.query.status).toLowerCase();

  try {
    const where = [];
    const params = [];

    if (q) {
      where.push("(LOWER(b.bus_code) LIKE ? OR LOWER(b.plate_no) LIKE ?)");
      params.push(`%${q}%`, `%${q}%`);
    }
    if (status && ["active", "inactive", "maintenance"].includes(status)) {
      where.push("b.bus_status = ?");
      params.push(status);
    }

    const sql = `
      SELECT
        b.id,
        b.bus_code,
        b.plate_no,
        b.capacity,
        b.bus_status,

        b.device_id,
        b.created_at,
        b.updated_at,

        d.device_code AS device_code,
        d.esp32_id AS esp32_id,
        d.gps_enabled AS gps_enabled,
        d.last_seen_at AS device_last_seen_at,

        (d.last_seen_at IS NOT NULL AND d.last_seen_at >= (NOW() - INTERVAL ${DEVICE_ONLINE_SECONDS} SECOND)) AS is_device_online,

        -- ✅ occupancy fields (from ir_status)
        irs.passenger_count AS passenger_count,
        irs.in_total AS in_total,
        irs.out_total AS out_total,
        irs.last_event AS last_event,
        irs.last_event_at AS last_event_at,
        irs.updated_at AS ir_updated_at
      FROM buses b
      LEFT JOIN iot_devices d ON d.id = b.device_id
      LEFT JOIN ir_status irs ON irs.device_id = b.device_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY b.id DESC
    `;

    const [rows] = await db.execute(sql, params);

    const out = rows.map((r) => {
      const cap = Number(r.capacity ?? 0);
      const pc = Number(r.passenger_count ?? 0);
      const occPct = cap > 0 ? Math.round((pc / cap) * 100) : null;

      return {
        id: r.id,
        bus_code: r.bus_code,
        plate_no: r.plate_no,
        capacity: r.capacity,
        bus_status: r.bus_status,

        device_status: r.device_id ? "assigned" : "unassigned",
        device_online: r.device_id ? !!r.is_device_online : false,
        device_last_seen_at: r.device_last_seen_at ?? null,

        // ✅ occupancy
        passenger_count: r.device_id ? pc : null,
        occupancy_percent: r.device_id ? occPct : null,

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
      };
    });

    return res.json(out);
  } catch (err) {
    console.error("getBuses error:", err);
    return res.status(500).json({ message: "Failed to fetch buses", error: err.message });
  }
}

// ✅ GET /api/admin/buses/:id
async function getBusById(req, res) {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid bus id" });

  try {
    const [rows] = await db.execute(
      `
      SELECT
        b.*,

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
        irs.updated_at AS ir_updated_at
      FROM buses b
      LEFT JOIN iot_devices d ON d.id = b.device_id
      LEFT JOIN ir_status irs ON irs.device_id = b.device_id
      WHERE b.id = ?
      LIMIT 1
      `,
      [id]
    );

    if (!rows[0]) return res.status(404).json({ message: "Bus not found" });

    const r = rows[0];
    const cap = Number(r.capacity ?? 0);
    const pc = Number(r.passenger_count ?? 0);
    const occPct = cap > 0 ? Math.round((pc / cap) * 100) : null;

    return res.json({
      id: r.id,
      bus_code: r.bus_code,
      plate_no: r.plate_no,
      capacity: r.capacity,
      bus_status: r.bus_status,

      device_status: r.device_id ? "assigned" : "unassigned",
      device_online: r.device_id ? !!r.is_device_online : false,
      device_last_seen_at: r.device_last_seen_at ?? null,

      passenger_count: r.device_id ? pc : null,
      occupancy_percent: r.device_id ? occPct : null,

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
    });
  } catch (err) {
    console.error("getBusById error:", err);
    return res.status(500).json({ message: "Failed to fetch bus", error: err.message });
  }
}

// POST /api/admin/buses
async function createBus(req, res) {
  const plate_no = cleanStr(req.body.plate_no);
  const capacity = toInt(req.body.capacity);
  const bus_status = cleanStr(req.body.bus_status || "active").toLowerCase();

  if (!plate_no) return res.status(400).json({ message: "plate_no is required" });
  if (!capacity || capacity <= 0) return res.status(400).json({ message: "capacity must be > 0" });
  if (!["active", "inactive", "maintenance"].includes(bus_status)) {
    return res.status(400).json({ message: "bus_status must be active|inactive|maintenance" });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const bus_code = await generateBusCode(conn);

    const [ins] = await conn.execute(
      `INSERT INTO buses (bus_code, plate_no, capacity, bus_status, device_id)
       VALUES (?, ?, ?, ?, NULL)`,
      [bus_code, plate_no, capacity, bus_status]
    );

    await conn.commit();
    return res.status(201).json({ message: "Bus created", id: ins.insertId, bus_code });
  } catch (err) {
    await conn.rollback();
    console.error("createBus error:", err);
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "Duplicate bus_code or plate_no", error: err.message });
    }
    return res.status(500).json({ message: "Failed to create bus", error: err.message });
  } finally {
    conn.release();
  }
}

// PUT /api/admin/buses/:id
async function updateBus(req, res) {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid bus id" });

  const plate_no = req.body.plate_no != null ? cleanStr(req.body.plate_no) : null;
  const capacity = req.body.capacity != null ? toInt(req.body.capacity) : null;
  const bus_status = req.body.bus_status != null ? cleanStr(req.body.bus_status).toLowerCase() : null;

  if (capacity != null && capacity <= 0) return res.status(400).json({ message: "capacity must be > 0" });
  if (bus_status != null && !["active", "inactive", "maintenance"].includes(bus_status)) {
    return res.status(400).json({ message: "bus_status must be active|inactive|maintenance" });
  }

  try {
    const [upd] = await db.execute(
      `
      UPDATE buses
      SET
        plate_no = COALESCE(?, plate_no),
        capacity = COALESCE(?, capacity),
        bus_status = COALESCE(?, bus_status)
      WHERE id = ?
      `,
      [plate_no, capacity, bus_status, id]
    );

    if (upd.affectedRows === 0) return res.status(404).json({ message: "Bus not found" });
    return res.json({ message: "Bus updated" });
  } catch (err) {
    console.error("updateBus error:", err);
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "Duplicate plate_no", error: err.message });
    }
    return res.status(500).json({ message: "Failed to update bus", error: err.message });
  }
}

// DELETE /api/admin/buses/:id
async function deleteBus(req, res) {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid bus id" });

  try {
    const [del] = await db.execute("DELETE FROM buses WHERE id = ?", [id]);
    if (del.affectedRows === 0) return res.status(404).json({ message: "Bus not found" });
    return res.json({ message: "Bus deleted" });
  } catch (err) {
    console.error("deleteBus error:", err);
    return res.status(500).json({ message: "Failed to delete bus", error: err.message });
  }
}

module.exports = { getBuses, getBusById, createBus, updateBus, deleteBus };
