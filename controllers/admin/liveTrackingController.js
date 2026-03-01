// controllers/admin/liveTrackingController.js
const db = require("../../db");

const OFFLINE_AFTER_SECONDS = 120;

function normalizeGpsState(v) {
  const s = String(v || "").trim().toLowerCase();
  if (["active", "searching", "disconnected", "disabled"].includes(s)) return s;
  return "searching";
}

function computeUiStatus({ is_online, gps_state }) {
  if (!Number(is_online)) return "Offline";
  const gs = normalizeGpsState(gps_state);
  if (gs === "disconnected" || gs === "searching" || gs === "disabled") return "Warning";
  return "Online";
}

function gpsBadge(gps_state) {
  const gs = normalizeGpsState(gps_state);
  if (gs === "active") return "GPS Active";
  if (gs === "searching") return "GPS Searching";
  if (gs === "disconnected") return "GPS Disconnected";
  return "GPS Disabled";
}

function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function makeRouteLabel(curName, tgtName) {
  const cur = curName || null;
  const tgt = tgtName || null;
  if (!cur && !tgt) return null;
  if (cur && tgt) return `${cur} → ${tgt}`;
  if (cur && !tgt) return `${cur} → —`;
  return `— → ${tgt}`;
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

        -- ✅ occupancy
        COALESCE(ir.passenger_count, 0) AS passenger_count,
        COALESCE(ir.in_total, 0)        AS in_total,
        COALESCE(ir.out_total, 0)       AS out_total,
        ir.last_event                  AS last_event,
        ir.last_event_at               AS last_event_at,
        ir.updated_at                  AS ir_updated_at,

        -- ✅ terminal state (routes / direction)
        bts.at_terminal                AS at_terminal,
        bts.current_terminal_id        AS current_terminal_id,
        ct.terminal_name               AS current_terminal_name,
        bts.target_terminal_id         AS target_terminal_id,
        tt.terminal_name               AS target_terminal_name,
        bts.dist_m                     AS dist_m,
        bts.last_seen_at               AS terminal_last_seen_at,
        bts.updated_at                 AS terminal_updated_at,

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

      LEFT JOIN bus_terminal_state bts ON bts.device_id = d.id
      LEFT JOIN terminals ct ON ct.terminal_id = bts.current_terminal_id
      LEFT JOIN terminals tt ON tt.terminal_id = bts.target_terminal_id

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

      const cap = Number(r.capacity ?? 0);
      const pc = Number(r.passenger_count ?? 0);
      const occupancy_percent = cap > 0 ? clampPct((pc / cap) * 100) : null;

      const route_label = makeRouteLabel(r.current_terminal_name, r.target_terminal_name);

      return {
        // basic bus/device/gps
        bus_id: r.bus_id,
        bus_code: r.bus_code,
        plate_no: r.plate_no,
        capacity: r.capacity,
        device_id: r.device_id,

        device_code: r.device_code,
        device_status: r.device_status,
        gps_enabled: Number(r.gps_enabled) === 1,
        gps_state: gps_state_norm,
        gps_badge: gpsBadge(gps_state_norm),
        last_seen_at: r.last_seen_at,

        lat: r.lat != null ? Number(r.lat) : null,
        lng: r.lng != null ? Number(r.lng) : null,
        speed_kmh: r.speed_kmh != null ? Number(r.speed_kmh) : null,
        updated_at: r.updated_at,

        // ✅ UI status pill
        status, // "Online" | "Warning" | "Offline"
        is_online: Number(r.is_online) === 1 ? 1 : 0,

        // ✅ occupancy for cards/table
        passenger_count: pc,
        occupancy_percent,
        in_total: Number(r.in_total ?? 0),
        out_total: Number(r.out_total ?? 0),
        last_event: r.last_event ?? "none",
        last_event_at: r.last_event_at ?? null,
        ir_updated_at: r.ir_updated_at ?? null,

        // ✅ terminal route info
        terminal_state: {
          at_terminal: Number(r.at_terminal) === 1 ? 1 : 0,
          current_terminal_id: r.current_terminal_id ?? null,
          current_terminal_name: r.current_terminal_name || null,
          target_terminal_id: r.target_terminal_id ?? null,
          target_terminal_name: r.target_terminal_name || null,
          dist_m: r.dist_m != null ? Number(r.dist_m) : null,
          last_seen_at: r.terminal_last_seen_at ?? null,
          updated_at: r.terminal_updated_at ?? null,
        },
        route_label, // "Calapan → Naujan"
      };
    });

    res.json(mapped);
  } catch (err) {
    console.error("getAdminLiveBuses error:", err);
    res.status(500).json({ message: "Failed to load admin live buses." });
  }
};