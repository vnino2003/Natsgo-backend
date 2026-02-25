// jobs/offlineDevicesJob.js
const cron = require("node-cron");
const db = require("../db");
const {
  CATEGORY,
  SEVERITY,
  AUDIENCE,
  ENTITY,
  upsertActiveAlert,
} = require("../services/notificationHelper");

const OFFLINE_SECONDS = Number(process.env.OFFLINE_SECONDS || 120);

async function markOfflineDevicesOnce() {
  const conn = await db.getConnection();
  try {
    // Find devices that should be marked offline
    const [rows] = await conn.execute(
      `
      SELECT id, device_code, esp32_id, gps_enabled
      FROM iot_devices
      WHERE status <> 'offline'
        AND last_seen_at IS NOT NULL
        AND last_seen_at < (NOW() - INTERVAL ? SECOND)
      `,
      [OFFLINE_SECONDS]
    );

    if (!rows.length) return { updated: 0 };

    // Mark offline
    await conn.execute(
      `
      UPDATE iot_devices
      SET status = 'offline',
          gps_state = CASE
            WHEN gps_enabled = 1 THEN 'disconnected'
            ELSE gps_state
          END,
          updated_at = NOW()
      WHERE status <> 'offline'
        AND last_seen_at IS NOT NULL
        AND last_seen_at < (NOW() - INTERVAL ? SECOND)
      `,
      [OFFLINE_SECONDS]
    );

    // Upsert ACTIVE offline alerts (dedupe per device)
    for (const d of rows) {
      const label = d.device_code || d.esp32_id || `Device#${d.id}`;
      const dedupe_key = `device_offline:${d.id}`;

      await upsertActiveAlert({
        conn,
        dedupe_key,
        category: CATEGORY.IOT,
        type: "DEVICE_OFFLINE",
        severity: SEVERITY.CRITICAL,
        audience: AUDIENCE.ADMIN,
        title: "Device offline",
        message: `${label} is offline (no telemetry for ${OFFLINE_SECONDS}s).`,
        entity_type: ENTITY.DEVICE,
        entity_id: d.id,
        meta: { offline_seconds: OFFLINE_SECONDS },
      });
    }

    return { updated: rows.length };
  } catch (err) {
    console.error("markOfflineDevicesOnce error:", err);
    return { updated: 0, error: err.message };
  } finally {
    conn.release();
  }
}

function startOfflineDevicesCron() {
  cron.schedule(
    "*/1 * * * *",
    async () => {
      const r = await markOfflineDevicesOnce();
      if (r.updated) console.log(`[offline-cron] Marked offline: ${r.updated}`);
    },
    { timezone: "Asia/Manila" }
  );

  console.log(`[offline-cron] Started. OFFLINE_SECONDS=${OFFLINE_SECONDS}`);
}

module.exports = { startOfflineDevicesCron, markOfflineDevicesOnce };