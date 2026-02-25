// controllers/admin/liveTrackingController.js
const db = require("../../db");

const OFFLINE_AFTER_SECONDS = 120;

function normalizeGpsState(v) {
  const s = String(v || "").trim().toLowerCase();
  if (["active", "searching", "disconnected", "disabled"].includes(s)) return s;
  // default if blank/unknown
  return "searching";
}

function computeUiStatus({ is_online, gps_state }) {
  // Online / Warning / Offline (for your UI pills)
  if (!Number(is_online)) return "Offline";

  const gs = normalizeGpsState(gps_state);
  if (gs === "disconnected" || gs === "searching" || gs === "disabled") return "Warning";

  return "Online"; // active
}

function gpsBadge(gps_state) {
  const gs = normalizeGpsState(gps_state);
  if (gs === "active") return "GPS Active";
  if (gs === "searching") return "GPS Searching";
  if (gs === "disconnected") return "GPS Disconnected";
  return "GPS Disabled";
}

exports.getAdminLiveBuses = async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT
        b.id              AS bus_id,
        b.bus_code        AS bus_code,
        b.plate_no        AS plate_no,
        b.capacity        AS capacity,
        b.bus_status      AS bus_status,
        b.device_id       AS device_id,

        d.device_code     AS device_code,
        d.status          AS device_status,
        d.gps_enabled     AS gps_enabled,
        d.gps_state       AS gps_state,
        d.last_seen_at    AS last_seen_at,

        g.lat,
        g.lng,
        g.speed_kmh       AS speed_kmh,
        g.recorded_at     AS updated_at,

        COALESCE(ir.passenger_count, 0) AS passenger_count,

        CASE
          WHEN d.last_seen_at IS NULL THEN 0
          WHEN TIMESTAMPDIFF(SECOND, d.last_seen_at, NOW()) <= ? THEN 1
          ELSE 0
        END AS is_online

      FROM buses b
      JOIN iot_devices d ON d.id = b.device_id

      JOIN (
        SELECT gl.*
        FROM gps_logs gl
        JOIN (
          SELECT device_id, MAX(recorded_at) AS max_time
          FROM gps_logs
          GROUP BY device_id
        ) last
          ON last.device_id = gl.device_id
         AND last.max_time  = gl.recorded_at
      ) g ON g.device_id = d.id

      LEFT JOIN (
        SELECT s.*
        FROM ir_status s
        JOIN (
          SELECT device_id, MAX(updated_at) AS max_u
          FROM ir_status
          GROUP BY device_id
        ) lastir
          ON lastir.device_id = s.device_id
         AND lastir.max_u     = s.updated_at
      ) ir ON ir.device_id = d.id

      WHERE b.device_id IS NOT NULL
      ORDER BY b.id ASC
      `,
      [OFFLINE_AFTER_SECONDS]
    );

    const mapped = rows.map((r) => {
      const gps_state_norm = normalizeGpsState(r.gps_state);

      const status = computeUiStatus({
        is_online: r.is_online,
        gps_state: gps_state_norm,
      });

      return {
        ...r,
        gps_state: gps_state_norm,
        gps_badge: gpsBadge(gps_state_norm),

        // ✅ FRONTEND USES THIS
        status, // "Online" | "Warning" | "Offline"
      };
    });

    res.json(mapped);
  } catch (err) {
    console.error("getAdminLiveBuses error:", err);
    res.status(500).json({ message: "Failed to load admin live buses." });
  }
};