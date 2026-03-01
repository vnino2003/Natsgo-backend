// controllers/gpsController.js
const db = require("../db");
const {
  CATEGORY,
  SEVERITY,
  AUDIENCE,
  ENTITY,
  upsertActiveAlert,
  resolveActiveAlert,
  createNotification,
} = require("../services/notificationHelper");

// ✅ import terminal-state updater (per telemetry)
const { updateOne } = require("./terminalStateController");

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

/**
 * Normalize any incoming gps_state to match ENUM('active','searching','disconnected','disabled')
 * Returns allowed values OR null (do not update).
 */
function normalizeGpsState(v, { gpsEnabledVal, latNum, lngNum } = {}) {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim().toLowerCase();

  if (["active", "searching", "disconnected", "disabled"].includes(s)) return s;

  if (s === "ok") return "active";
  if (s === "no_fix" || s === "nofix" || s === "no-fix") return "searching";
  if (s === "stale") return "disconnected";
  if (s === "offline") return "disconnected";

  if (s === "unknown" || s === "n/a") {
    if (gpsEnabledVal === 0) return "disabled";
    const hasFix = latNum !== null && lngNum !== null;
    return hasFix ? "active" : "searching";
  }

  return null;
}

/* =========================================================
   POST /api/gps/telemetry
   - updates device last_seen
   - sets device status='online' on every telemetry ✅
   - upserts gps_logs (1 row per device)
   - upserts ir_status (if present)
   - ✅ notifications:
        - resolve DEVICE_OFFLINE when telemetry returns + create DEVICE_ONLINE
        - upsert GPS_DISCONNECTED while disconnected
        - resolve GPS_DISCONNECTED when recovered + create GPS_ACTIVE/GPS_SEARCHING
   - ✅ NEW: updates bus_terminal_state in real-time per telemetry (if lat/lng present)
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

  const latNum = toNum(lat);
  const lngNum = toNum(lng);

  const gpsStateNorm = normalizeGpsState(gps_state, {
    gpsEnabledVal,
    latNum,
    lngNum,
  });

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

    const prevGpsState = deviceRow ? deviceRow.gps_state : null;
    const prevStatus = deviceRow ? deviceRow.status : null;

    /* ===== 2) Insert device if missing, else update last_seen ===== */
    const now = new Date();
    let deviceId;

    if (!deviceRow) {
      const gpsStateForInsert = gpsStateNorm || (gpsEnabledVal ? "searching" : "disabled");

      const [ins] = await conn.execute(
        `
        INSERT INTO iot_devices
          (device_code, esp32_id, gps_enabled, gps_state, ir_enabled, status, last_seen_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'online', ?, NOW(), NOW())
        `,
        [
          device_code || `DEV-${Date.now()}`,
          esp32_id || null,
          gpsEnabledVal,
          gpsStateForInsert,
          irEnabledVal ?? 1,
          now,
        ]
      );

      deviceId = ins.insertId;
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
            status = 'online',
            last_seen_at = ?,
            updated_at = NOW()
        WHERE id = ?
        `,
        [esp32_id || null, gpsEnabledVal, gpsStateNorm, irEnabledVal, now, deviceId]
      );
    }

    // final gps state we consider AFTER update
    const nextGpsState =
      gpsStateNorm ||
      (deviceRow ? deviceRow.gps_state : (gpsEnabledVal ? "searching" : "disabled"));

    // keys for dedupe alerts
    const offlineKey = `device_offline:${deviceId}`;
    const gpsDiscKey = `gps_disconnected:${deviceId}`;
    const label = device_code || esp32_id || `Device#${deviceId}`;

    /* ===== 2.5) Resolve offline when telemetry returns + create online event ===== */
    if (prevStatus === "offline") {
      await resolveActiveAlert(offlineKey, { conn });

      await createNotification({
        conn,
        category: CATEGORY.IOT,
        type: "DEVICE_ONLINE",
        severity: SEVERITY.INFO,
        audience: AUDIENCE.ADMIN,
        title: "Device back online",
        message: `${label} is online again.`,
        entity_type: ENTITY.DEVICE,
        entity_id: deviceId,
        active: 0,
        unread: 1,
        meta: { from: "offline", to: "online" },
      });
    }

    /* ===== 2.6) GPS disconnected alert + recovery event ===== */
    const wasDisconnected = prevGpsState === "disconnected";
    const isDisconnected = nextGpsState === "disconnected";

    if (gpsEnabledVal === 1) {
      if (isDisconnected) {
        await upsertActiveAlert({
          conn,
          dedupe_key: gpsDiscKey,
          category: CATEGORY.IOT,
          type: "GPS_DISCONNECTED",
          severity: SEVERITY.WARNING,
          audience: AUDIENCE.ADMIN,
          title: "GPS disconnected",
          message: `${label} GPS is disconnected.`,
          entity_type: ENTITY.DEVICE,
          entity_id: deviceId,
          meta: { gps_state: nextGpsState },
        });
      } else {
        if (wasDisconnected) {
          await resolveActiveAlert(gpsDiscKey, { conn });

          const recoveredType = nextGpsState === "active" ? "GPS_ACTIVE" : "GPS_SEARCHING";
          const recoveredTitle = nextGpsState === "active" ? "GPS active" : "GPS searching";
          const recoveredMsg =
            nextGpsState === "active"
              ? `${label} GPS is active again.`
              : `${label} GPS reconnected but still searching for fix.`;

          await createNotification({
            conn,
            category: CATEGORY.IOT,
            type: recoveredType,
            severity: SEVERITY.INFO,
            audience: AUDIENCE.ADMIN,
            title: recoveredTitle,
            message: recoveredMsg,
            entity_type: ENTITY.DEVICE,
            entity_id: deviceId,
            active: 0,
            unread: 1,
            meta: { from: "disconnected", to: nextGpsState },
          });
        }
      }
    } else {
      if (wasDisconnected) {
        await resolveActiveAlert(gpsDiscKey, { conn });
      }
    }

    /* ===== 3) Upsert gps_logs (1 row per device) ===== */
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

    /* ===== 3.5) ✅ REAL-TIME terminal state update (per telemetry) ===== */
    const shouldUpdateTerminalState =
      deviceId &&
      gpsEnabledVal === 1 &&
      latNum !== null &&
      lngNum !== null &&
      nextGpsState !== "disabled"; // optional

    if (shouldUpdateTerminalState) {
    const [terminals] = await conn.execute(
  `SELECT terminal_id, lat, lng
   FROM terminals
   ORDER BY terminal_id ASC`
);

      // your updateOne logic expects exactly 2 active terminals
      if (terminals && terminals.length === 2) {
        const arrivalM = Number(process.env.TERMINAL_ARRIVAL_M || 120);
        const departM = Number(process.env.TERMINAL_DEPART_M || 180);

        await updateOne({
          conn,
          deviceId,
          lat: latNum,
          lng: lngNum,
          terminals,
          arrivalM,
          departM,
        });
      }
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