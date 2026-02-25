// controllers/commuter/trackController.js
const db = require("../../db");

const OFFLINE_AFTER_SECONDS = 120; // adjust: 30/60/120

exports.getLiveAssignedBuses = async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT
        b.id            AS bus_id,
        b.bus_code      AS bus_code,
        b.plate_no      AS plate_no,
        b.capacity      AS capacity,
        b.bus_status    AS bus_status,
        b.device_id     AS device_id,

        d.device_code   AS device_code,
        d.esp32_id      AS esp32_id,
        d.status        AS device_status,
        d.gps_state     AS gps_state,
        d.last_seen_at  AS last_seen_at,

        g.lat           AS lat,
        g.lng           AS lng,
        g.speed_kmh     AS speed_kmh,
        g.altitude_m    AS altitude_m,
        g.hdop          AS hdop,
        g.satellites    AS satellites,
        g.recorded_at   AS updated_at,

        COALESCE(ir.passenger_count, 0) AS passenger_count,
        COALESCE(ir.in_total, 0)        AS in_total,
        COALESCE(ir.out_total, 0)       AS out_total,
        ir.last_event                   AS last_event,
        ir.last_event_at                AS last_event_at,

        bts.current_terminal_id         AS current_terminal_id,
        bts.target_terminal_id          AS target_terminal_id,
        COALESCE(bts.at_terminal, 0)    AS at_terminal,
        bts.dist_m                      AS dist_m,

        tc.terminal_name                AS current_terminal_name,
        tt.terminal_name                AS target_terminal_name,

        -- ✅ ONLINE RULE
        CASE
          WHEN d.last_seen_at IS NULL THEN 0
          WHEN TIMESTAMPDIFF(SECOND, d.last_seen_at, NOW()) <= ? THEN 1
          ELSE 0
        END AS is_online

      FROM buses b
      JOIN iot_devices d
        ON d.id = b.device_id

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
      ) g
        ON g.device_id = d.id

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
      ) ir
        ON ir.device_id = d.id

      LEFT JOIN bus_terminal_state bts
        ON bts.device_id = d.id
      LEFT JOIN terminals tc
        ON tc.terminal_id = bts.current_terminal_id
      LEFT JOIN terminals tt
        ON tt.terminal_id = bts.target_terminal_id

      WHERE b.device_id IS NOT NULL

        -- ✅ device must be online + recently seen
        AND d.status = 'online'
        AND d.last_seen_at IS NOT NULL
        AND TIMESTAMPDIFF(SECOND, d.last_seen_at, NOW()) <= ?

        -- ✅ ONLY show buses with GPS ACTIVE (hide searching/disconnected/disabled)
        AND LOWER(COALESCE(d.gps_state, '')) = 'active'

        -- ✅ bus must be “okay/active”
        -- If your bus_status values are different, adjust this list.
        AND LOWER(COALESCE(b.bus_status, 'active')) IN ('active', 'online', 'in_service')

        -- ✅ must have coordinates
        AND g.lat IS NOT NULL
        AND g.lng IS NOT NULL

      ORDER BY b.id ASC
      `,
      [OFFLINE_AFTER_SECONDS, OFFLINE_AFTER_SECONDS]
    );

    res.json(rows);
  } catch (err) {
    console.error("getLiveAssignedBuses error:", err);
    res.status(500).json({ message: "Failed to load live buses." });
  }
};