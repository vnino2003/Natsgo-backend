// controllers/deviceController.js
const db = require("../db");

const OFFLINE_SECONDS = 120;     // device offline if no telemetry within 120s
const GPS_STALE_SECONDS = 120;   // gps stale if no gps update within 120s
const IR_STALE_SECONDS = 300;    // IR heartbeat stale (use 300s since events are not constant)

function isFresh(ts, seconds) {
  if (!ts) return false;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= Date.now() - seconds * 1000;
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

        d.gps_enabled,
        d.gps_state,
        d.last_seen_at,

        d.ir_enabled,
        d.ir_state,
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

        (d.created_at >= (NOW() - INTERVAL ? HOUR)) AS is_new,
        (d.last_seen_at IS NOT NULL AND d.last_seen_at >= (NOW() - INTERVAL ${OFFLINE_SECONDS} SECOND)) AS is_online_calc
      FROM iot_devices d
      LEFT JOIN gps_logs g
        ON g.device_id = d.id
      LEFT JOIN ir_status irs
        ON irs.device_id = d.id
      ${newOnly ? "WHERE d.created_at >= (NOW() - INTERVAL ? HOUR)" : ""}
      ORDER BY d.created_at DESC
    `;

    const params = newOnly ? [hours, hours] : [hours];
    const [rows] = await db.execute(sql, params);

    const out = rows.map((r) => {
      const isOnline = !!r.is_online_calc;

      // ----- GPS computed state -----
      const gpsEnabled = Number(r.gps_enabled) === 1;
      const hasFix = r.lat !== null && r.lng !== null;
      const gpsFresh = isFresh(r.gps_recorded_at, GPS_STALE_SECONDS);

      let gps_state = "disabled";
      if (gpsEnabled) {
        if (!isOnline) gps_state = "stale";
        else if (!gpsFresh) gps_state = "stale";
        else gps_state = hasFix ? "ok" : "no_fix";
      }

      // ----- IR computed state -----
      const irEnabled = Number(r.ir_enabled) === 1;
      const irFresh = isFresh(r.ir_last_seen_at, IR_STALE_SECONDS);

      let ir_state = "disabled";
      if (irEnabled) {
        if (!isOnline) ir_state = "stale";
        else ir_state = irFresh ? "ok" : "stale";
      }

      // overall status/health
      const status = isOnline ? "online" : "offline";

      // Example health logic:
      // - Offline -> Offline
      // - Online + GPS ok + IR ok -> Healthy
      // - Online but any stale/no_fix -> Warning
      const health_state =
        !isOnline
          ? "Offline"
          : (gps_state === "ok" && ir_state === "ok")
            ? "Healthy"
            : "Warning";

      return {
        ...r,
        status,
        is_online: isOnline,

        gps_state,
        gps_ok: gps_state === "ok",

        ir_state,
        ir_ok: ir_state === "ok",

        health_state
      };
    });

    return res.json(out);
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
        irs.updated_at AS ir_updated_at
      FROM iot_devices d
      LEFT JOIN gps_logs g ON g.device_id = d.id
      LEFT JOIN ir_status irs ON irs.device_id = d.id
      WHERE d.id = ?
      LIMIT 1
      `,
      [id]
    );

    if (!rows[0]) return res.status(404).json({ message: "Device not found" });

    const r = rows[0];
    const isOnline = isFresh(r.last_seen_at, OFFLINE_SECONDS);

    const gpsEnabled = Number(r.gps_enabled) === 1;
    const hasFix = r.lat !== null && r.lng !== null;
    const gpsFresh = isFresh(r.gps_recorded_at, GPS_STALE_SECONDS);

    let gps_state = "disabled";
    if (gpsEnabled) {
      if (!isOnline) gps_state = "stale";
      else if (!gpsFresh) gps_state = "stale";
      else gps_state = hasFix ? "ok" : "no_fix";
    }

    const irEnabled = Number(r.ir_enabled) === 1;
    const irFresh = isFresh(r.ir_last_seen_at, IR_STALE_SECONDS);

    let ir_state = "disabled";
    if (irEnabled) {
      if (!isOnline) ir_state = "stale";
      else ir_state = irFresh ? "ok" : "stale";
    }

    const status = isOnline ? "online" : "offline";
    const health_state =
      !isOnline ? "Offline" : (gps_state === "ok" && ir_state === "ok") ? "Healthy" : "Warning";

    return res.json({
      ...r,
      status,
      is_online: isOnline,

      gps_state,
      gps_ok: gps_state === "ok",

      ir_state,
      ir_ok: ir_state === "ok",

      health_state
    });
  } catch (err) {
    console.error("getDeviceById error:", err);
    return res.status(500).json({ message: "Failed to fetch device", error: err.message });
  }
}

module.exports = { getDevices, getDeviceById };
