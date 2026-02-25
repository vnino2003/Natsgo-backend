// controllers/deviceController.js
const db = require("../db");

const OFFLINE_SECONDS = 120;   // device offline if no telemetry within 120s
const IR_STALE_SECONDS = 300;  // IR stale logic (pwede mong i-keep)

function isFresh(ts, seconds) {
  if (!ts) return false;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= Date.now() - seconds * 1000;
}

function normalizeGpsState(v) {
  const s = String(v || "").toLowerCase().trim();
  // allowed: active | searching | disconnected | disabled (safe extra)
  if (s === "active" || s === "searching" || s === "disconnected" || s === "disabled") return s;
  return "searching";
}

function normalizeIrState(v) {
  const s = String(v || "").toLowerCase().trim();
  // allowed: ok | stale | disabled (safe extra)
  if (s === "ok" || s === "stale" || s === "disabled") return s;
  return "stale";
}

/**
 * Effective states for UI
 * - ONLINE  => use DB-reported states
 * - OFFLINE => force gps=disconnected (if enabled), ir=stale (if enabled)
 */
function computeEffectiveStates(r) {
  const isOnline = !!r.is_online_calc;

  // ----- GPS effective state (DB-driven) -----
  const gpsEnabled = Number(r.gps_enabled) === 1;

  let gps_state_effective = "disabled";
  if (gpsEnabled) {
    if (!isOnline) gps_state_effective = "disconnected";
    else gps_state_effective = normalizeGpsState(r.gps_state_reported);
  }

  // ----- IR effective state -----
  const irEnabled = Number(r.ir_enabled) === 1;

  let ir_state_effective = "disabled";
  if (irEnabled) {
    if (!isOnline) {
      ir_state_effective = "stale";
    } else {
      // DB-driven
      ir_state_effective = normalizeIrState(r.ir_state_reported);

      // If you want timestamp-based override, uncomment:
      // const irFresh = isFresh(r.ir_last_seen_at, IR_STALE_SECONDS);
      // ir_state_effective = irFresh ? "ok" : "stale";
    }
  }

  const status_effective = isOnline ? "online" : "offline";

  const health_state =
    !isOnline
      ? "Offline"
      : (gps_state_effective === "active" && ir_state_effective === "ok")
        ? "Healthy"
        : "Warning";

  return {
    isOnline,
    status_effective,
    gps_state_effective,
    ir_state_effective,
    health_state,
  };
}

// GET /api/admin/devices?new_only=1&new_hours=24
async function getDevices(req, res) {
  const newOnly = req.query.new_only === "1";
  const newHours = Number(req.query.new_hours || 24);
  const hours = Number.isFinite(newHours) && newHours > 0 ? newHours : 24;

  try {
    const sql = `
      SELECT
        d.id,
        d.device_code,
        d.esp32_id,

        d.status AS status_db,
        d.gps_enabled,
        d.gps_state AS gps_state_reported,
        d.last_seen_at,

        d.ir_enabled,
        d.ir_state AS ir_state_reported,
        d.ir_last_seen_at,

        d.created_at,
        d.updated_at,

        g.lat,
        g.lng,
        g.speed_kmh,
        g.altitude_m,
        g.hdop,
        g.satellites,
        g.recorded_at AS gps_recorded_at,

        irs.passenger_count,
        irs.in_total,
        irs.out_total,
        irs.last_event,
        irs.last_event_at,
        irs.updated_at AS ir_updated_at,

        /* ✅ Assignment (Bus) */
        b.id AS bus_id,
        b.bus_code AS bus_code,
        b.plate_no AS bus_plate_no,

        (d.created_at >= (NOW() - INTERVAL ? HOUR)) AS is_new,
        (d.last_seen_at IS NOT NULL AND d.last_seen_at >= (NOW() - INTERVAL ${OFFLINE_SECONDS} SECOND)) AS is_online_calc
      FROM iot_devices d
      LEFT JOIN gps_logs g ON g.device_id = d.id
      LEFT JOIN ir_status irs ON irs.device_id = d.id
      /* ✅ Join bus assignment: buses.device_id points to iot_devices.id */
      LEFT JOIN buses b ON b.device_id = d.id
      ${newOnly ? "WHERE d.created_at >= (NOW() - INTERVAL ? HOUR)" : ""}
      ORDER BY d.created_at DESC
    `;

    const params = newOnly ? [hours, hours] : [hours];
    const [rows] = await db.execute(sql, params);

    const computed = rows.map((r) => {
      const {
        isOnline,
        status_effective,
        gps_state_effective,
        ir_state_effective,
        health_state,
      } = computeEffectiveStates(r);

      return {
        ...r,

        // Effective/UI fields
        status: status_effective,
        is_online: isOnline,

        gps_state: gps_state_effective,
        gps_ok: gps_state_effective === "active",

        ir_state: ir_state_effective,
        ir_ok: ir_state_effective === "ok",

        health_state,

        // Reported fields
        gps_state_reported: r.gps_state_reported,
        ir_state_reported: r.ir_state_reported,
        status_db: r.status_db,

        // Convenience fields (optional)
        assignment: r.bus_code || r.bus_plate_no || null,
      };
    });

    return res.json(computed);
  } catch (err) {
    console.error("getDevices error:", err);
    return res.status(500).json({ message: "Failed to fetch devices", error: err.message });
  }
}

// GET /api/admin/devices/:id
async function getDeviceById(req, res) {
  const { id } = req.params;

  try {
    const [rows] = await db.execute(
      `
      SELECT
        d.*,
        d.status AS status_db,
        d.gps_state AS gps_state_reported,
        d.ir_state AS ir_state_reported,

        g.lat,
        g.lng,
        g.speed_kmh,
        g.altitude_m,
        g.hdop,
        g.satellites,
        g.recorded_at AS gps_recorded_at,

        irs.passenger_count,
        irs.in_total,
        irs.out_total,
        irs.last_event,
        irs.last_event_at,
        irs.updated_at AS ir_updated_at,

        /* ✅ Assignment (Bus) */
        b.id AS bus_id,
        b.bus_code AS bus_code,
        b.plate_no AS bus_plate_no,

        (d.last_seen_at IS NOT NULL AND d.last_seen_at >= (NOW() - INTERVAL ${OFFLINE_SECONDS} SECOND)) AS is_online_calc
      FROM iot_devices d
      LEFT JOIN gps_logs g ON g.device_id = d.id
      LEFT JOIN ir_status irs ON irs.device_id = d.id
      /* ✅ Join bus assignment */
      LEFT JOIN buses b ON b.device_id = d.id
      WHERE d.id = ?
      LIMIT 1
      `,
      [id]
    );

    if (!rows[0]) return res.status(404).json({ message: "Device not found" });

    const r = rows[0];

    const {
      isOnline,
      status_effective,
      gps_state_effective,
      ir_state_effective,
      health_state,
    } = computeEffectiveStates(r);

    return res.json({
      ...r,

      // Effective/UI fields
      status: status_effective,
      is_online: isOnline,

      gps_state: gps_state_effective,
      gps_ok: gps_state_effective === "active",

      ir_state: ir_state_effective,
      ir_ok: ir_state_effective === "ok",

      health_state,

      // Reported fields
      gps_state_reported: r.gps_state_reported,
      ir_state_reported: r.ir_state_reported,
      status_db: r.status_db,

      // Convenience
      assignment: r.bus_code || r.bus_plate_no || null,
    });
  } catch (err) {
    console.error("getDeviceById error:", err);
    return res.status(500).json({ message: "Failed to fetch device", error: err.message });
  }
}

module.exports = { getDevices, getDeviceById };