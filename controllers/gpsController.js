// controllers/gpsController.js
const db = require("../db");

/* ================= Helpers ================= */
function toNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* =========================================================
   POST /api/gps/telemetry
   - updates device last_seen
   - upserts gps_logs (1 row per device)
   - upserts ir_status (if present)
   - ✅ updates bus_terminal_state (nearest terminal + at_terminal)
   ========================================================= */
async function postTelemetry(req, res) {
  const {
    device_code,
    esp32_id,

    // GPS
    gps_enabled,
    gps_state,
    lat,
    lng,
    speed_kmh,
    altitude_m,
    hdop,
    satellites,
    recorded_at,

    // IR
    ir_enabled,
    ir_alive,
    passenger_count,
    in_total,
    out_total,
    last_event,
    last_event_at,
  } = req.body;

  if (!device_code && !esp32_id) {
    return res.status(400).json({ message: "device_code or esp32_id is required" });
  }

  const gpsEnabledVal = gps_enabled === 0 || gps_enabled === "0" ? 0 : 1;

  const irEnabledVal =
    ir_enabled === undefined || ir_enabled === null
      ? null
      : ir_enabled === 0 || ir_enabled === "0"
        ? 0
        : 1;

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    /* ===== 1) Find device by code / esp32_id ===== */
    let deviceRow = null;

    if (device_code) {
      const [rows] = await conn.execute(
        "SELECT * FROM iot_devices WHERE device_code = ? LIMIT 1",
        [device_code]
      );
      deviceRow = rows[0] || null;
    }

    if (!deviceRow && esp32_id) {
      const [rows] = await conn.execute(
        "SELECT * FROM iot_devices WHERE esp32_id = ? LIMIT 1",
        [esp32_id]
      );
      deviceRow = rows[0] || null;
    }

    /* ===== 2) Insert device if missing, else update last_seen ===== */
    const now = new Date();
    let deviceId;

    if (!deviceRow) {
      const [ins] = await conn.execute(
        `
        INSERT INTO iot_devices
          (device_code, esp32_id, gps_enabled, gps_state, ir_enabled, last_seen_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
        `,
        [
          device_code || `DEV-${Date.now()}`,
          esp32_id || null,
          gpsEnabledVal,
          gps_state || "unknown",
          irEnabledVal ?? 1,
          now,
        ]
      );
      deviceId = ins.insertId;

      // create default ir_status row
      await conn.execute(`INSERT INTO ir_status (device_id) VALUES (?)`, [deviceId]);
    } else {
      deviceId = deviceRow.id;

      await conn.execute(
        `
        UPDATE iot_devices
        SET esp32_id = COALESCE(?, esp32_id),
            gps_enabled = ?,
            gps_state = COALESCE(?, gps_state),
            ir_enabled = COALESCE(?, ir_enabled),
            last_seen_at = ?,
            updated_at = NOW()
        WHERE id = ?
        `,
        [esp32_id || null, gpsEnabledVal, gps_state || null, irEnabledVal, now, deviceId]
      );
    }

    /* ===== 3) Upsert gps_logs (1 row per device) ===== */
    const latNum = toNum(lat);
    const lngNum = toNum(lng);

    if (deviceId && latNum !== null && lngNum !== null) {
      await conn.execute(
        `
        INSERT INTO gps_logs
          (device_id, lat, lng, speed_kmh, altitude_m, hdop, satellites, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW()))
        ON DUPLICATE KEY UPDATE
          lat = VALUES(lat),
          lng = VALUES(lng),
          speed_kmh = VALUES(speed_kmh),
          altitude_m = VALUES(altitude_m),
          hdop = VALUES(hdop),
          satellites = VALUES(satellites),
          recorded_at = COALESCE(VALUES(recorded_at), NOW())
        `,
        [
          deviceId,
          latNum,
          lngNum,
          toNum(speed_kmh),
          toNum(altitude_m),
          toNum(hdop),
          toNum(satellites),
          recorded_at || null,
        ]
      );
    }

    /* ===== 4) IR heartbeat + status upsert ===== */
    const hasIrHeartbeat = ir_alive === 1 || ir_alive === "1";

    const hasIrUpdate =
      passenger_count !== undefined ||
      in_total !== undefined ||
      out_total !== undefined ||
      (last_event !== undefined && last_event !== null) ||
      (last_event_at !== undefined && last_event_at !== null);

    if (deviceId && (hasIrHeartbeat || hasIrUpdate)) {
      await conn.execute(
        `
        UPDATE iot_devices
        SET ir_last_seen_at = NOW(),
            ir_state = 'ok'
        WHERE id = ?
        `,
        [deviceId]
      );

      if (hasIrUpdate) {
        const pc = toInt(passenger_count);
        const inT = toInt(in_total);
        const outT = toInt(out_total);

        const le = ["in", "out", "none"].includes(String(last_event || "none").toLowerCase())
          ? String(last_event || "none").toLowerCase()
          : "none";

        await conn.execute(
          `
          INSERT INTO ir_status
            (device_id, passenger_count, in_total, out_total, last_event, last_event_at)
          VALUES
            (?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            passenger_count = COALESCE(VALUES(passenger_count), passenger_count),
            in_total        = COALESCE(VALUES(in_total), in_total),
            out_total       = COALESCE(VALUES(out_total), out_total),
            last_event      = COALESCE(VALUES(last_event), last_event),
            last_event_at   = COALESCE(VALUES(last_event_at), last_event_at),
            updated_at      = NOW()
          `,
          [deviceId, pc, inT, outT, le, last_event_at || null]
        );
      }
    }

    /* ===== 5) ✅ Terminal proximity (GPS → bus_terminal_state) ===== */
    // arrival / depart radiuses (adjust for your place)
    const ARRIVAL_RADIUS_M = 120;
    const DEPART_RADIUS_M = 180;

    if (deviceId && latNum !== null && lngNum !== null) {
      const [terms] = await conn.execute(
        `SELECT terminal_id, lat, lng FROM terminals WHERE is_active = 1`
      );

      if (terms.length) {
        let nearest = null;
        let best = Infinity;

        for (const t of terms) {
          const d = haversineMeters(
            latNum,
            lngNum,
            Number(t.lat),
            Number(t.lng)
          );
          if (d < best) {
            best = d;
            nearest = t;
          }
        }

        const [prevRows] = await conn.execute(
          `SELECT at_terminal, current_terminal_id FROM bus_terminal_state WHERE device_id = ? LIMIT 1`,
          [deviceId]
        );
        const prev = prevRows[0] || null;

        const wasAt = prev ? Number(prev.at_terminal) === 1 : false;

        let at_terminal = 0;
        let current_terminal_id = null;

        if (!wasAt) {
          // arrive rule
          if (best <= ARRIVAL_RADIUS_M && nearest) {
            at_terminal = 1;
            current_terminal_id = nearest.terminal_id;
          }
        } else {
          // stay until depart radius exceeded
          if (best <= DEPART_RADIUS_M) {
            at_terminal = 1;
            current_terminal_id = prev.current_terminal_id;
          } else {
            at_terminal = 0;
            current_terminal_id = null;
          }
        }

        await conn.execute(
          `
          INSERT INTO bus_terminal_state
            (device_id, current_terminal_id, at_terminal, dist_m, last_seen_at)
          VALUES (?, ?, ?, ?, NOW())
          ON DUPLICATE KEY UPDATE
            current_terminal_id = VALUES(current_terminal_id),
            at_terminal = VALUES(at_terminal),
            dist_m = VALUES(dist_m),
            last_seen_at = VALUES(last_seen_at),
            updated_at = NOW()
          `,
          [deviceId, current_terminal_id, at_terminal, best]
        );
      }
    }

    await conn.commit();
    return res.status(201).json({ message: "Telemetry saved", device_id: deviceId });
  } catch (err) {
    await conn.rollback();
    console.error("postTelemetry error:", err);
    return res.status(500).json({
      message: "Failed to save telemetry",
      error: err.message,
      code: err.code,
    });
  } finally {
    conn.release();
  }
}

module.exports = { postTelemetry };
