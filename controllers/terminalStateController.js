// controllers/terminalStateController.js
const db = require("../db");

/* ---------- helpers ---------- */
function toNum(v) {
  const n = Number(v);
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

function otherTerminalId(terminals, id) {
  if (!terminals || terminals.length < 2) return null;
  return terminals[0].terminal_id === id ? terminals[1].terminal_id : terminals[0].terminal_id;
}

/**
 * Update bus_terminal_state for ONE device based on latest lat/lng
 */
async function updateOne({ conn, deviceId, lat, lng, terminals, arrivalM, departM }) {
  // nearest terminal
  let nearest = null;
  let best = Infinity;

  for (const t of terminals) {
    const d = haversineMeters(lat, lng, Number(t.lat), Number(t.lng));
    if (d < best) {
      best = d;
      nearest = t;
    }
  }

  // prev state
  const [prevRows] = await conn.execute(
    `SELECT at_terminal, current_terminal_id, target_terminal_id
     FROM bus_terminal_state
     WHERE device_id = ?
     LIMIT 1`,
    [deviceId]
  );
  const prev = prevRows[0] || null;

  const wasAt = prev ? Number(prev.at_terminal) === 1 : false;
  let current_terminal_id = prev?.current_terminal_id ?? null;
  let target_terminal_id = prev?.target_terminal_id ?? null;
  let at_terminal = 0;

  // entering
  if (!wasAt) {
    if (nearest && best <= arrivalM) {
      at_terminal = 1;
      current_terminal_id = nearest.terminal_id;
      target_terminal_id = otherTerminalId(terminals, current_terminal_id);
    } else {
      at_terminal = 0;
      // if we already have a last terminal, keep direction to other
      if (current_terminal_id) {
        target_terminal_id = otherTerminalId(terminals, current_terminal_id);
      }
    }
  } else {
    // staying/leaving
    if (current_terminal_id && best <= departM) {
      at_terminal = 1;
      target_terminal_id = otherTerminalId(terminals, current_terminal_id);
    } else {
      at_terminal = 0;
      // keep last current_terminal_id to preserve "where it came from"
      if (current_terminal_id) {
        target_terminal_id = otherTerminalId(terminals, current_terminal_id);
      }
    }
  }

  await conn.execute(
    `
    INSERT INTO bus_terminal_state
      (device_id, current_terminal_id, target_terminal_id, at_terminal, dist_m, last_seen_at)
    VALUES (?, ?, ?, ?, ?, NOW())
    ON DUPLICATE KEY UPDATE
      current_terminal_id = VALUES(current_terminal_id),
      target_terminal_id  = VALUES(target_terminal_id),
      at_terminal         = VALUES(at_terminal),
      dist_m              = VALUES(dist_m),
      last_seen_at        = VALUES(last_seen_at),
      updated_at          = NOW()
    `,
    [deviceId, current_terminal_id, target_terminal_id, at_terminal, best]
  );

  return { deviceId, current_terminal_id, target_terminal_id, at_terminal, dist_m: best };
}

/* =========================================================
   GET /api/admin/terminal-state/summary
   - counts buses at each terminal (at_terminal=1)
========================================================= */
async function getTerminalStateSummary(req, res) {
  try {
    const [terms] = await db.execute(
      `SELECT terminal_id, terminal_name, city, lat, lng
      FROM terminals
ORDER BY terminal_id ASC`
    );

    const [counts] = await db.execute(
      `
      SELECT current_terminal_id, COUNT(*) AS bus_count
      FROM bus_terminal_state
      GROUP BY current_terminal_id
      `
    );

    const countMap = new Map(counts.map((r) => [r.current_terminal_id, Number(r.bus_count)]));
    const out = terms.map((t) => ({
      terminal_id: t.terminal_id,
      terminal_name: t.terminal_name,
      city: t.city,
      lat: Number(t.lat),
      lng: Number(t.lng),
      bus_count: countMap.get(t.terminal_id) || 0,
    }));

    return res.json({ terminals: out });
  } catch (err) {
    console.error("getTerminalStateSummary error:", err);
    return res.status(500).json({ message: "Failed to load terminal summary", error: err.message });
  }
}

/* =========================================================
   GET /api/admin/terminal-state/devices
   - list all bus_terminal_state joined with terminal names
========================================================= */
async function getTerminalStateDevices(req, res) {
  try {
    const [rows] = await db.execute(
      `
      SELECT
        bts.device_id,
        bts.current_terminal_id,
        ct.terminal_name AS current_terminal_name,
        bts.target_terminal_id,
        tt.terminal_name AS target_terminal_name,
        bts.at_terminal,
        bts.dist_m,
        bts.last_seen_at,
        bts.updated_at
      FROM bus_terminal_state bts
      LEFT JOIN terminals ct ON ct.terminal_id = bts.current_terminal_id
      LEFT JOIN terminals tt ON tt.terminal_id = bts.target_terminal_id
      ORDER BY bts.device_id ASC
      `
    );

    return res.json(
      rows.map((r) => ({
        device_id: r.device_id,
        current_terminal_id: r.current_terminal_id,
        current_terminal_name: r.current_terminal_name || null,
        target_terminal_id: r.target_terminal_id,
        target_terminal_name: r.target_terminal_name || null,
        at_terminal: Number(r.at_terminal) === 1 ? 1 : 0,
        dist_m: r.dist_m != null ? Number(r.dist_m) : null,
        last_seen_at: r.last_seen_at ?? null,
        updated_at: r.updated_at ?? null,
      }))
    );
  } catch (err) {
    console.error("getTerminalStateDevices error:", err);
    return res.status(500).json({ message: "Failed to load terminal state devices", error: err.message });
  }
}

/* =========================================================
   POST /api/admin/terminal-state/recompute
   Body: { arrival_m?: number, depart_m?: number }
   - recompute bus_terminal_state for ALL devices using latest gps_logs
========================================================= */
async function recomputeTerminalState(req, res) {
  const arrivalM = toNum(req.body?.arrival_m) ?? 60;
  const departM = toNum(req.body?.depart_m) ?? 80;

  if (arrivalM <= 0 || departM <= 0 || departM < arrivalM) {
    return res.status(400).json({ message: "Invalid arrival/depart radius values" });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [terminals] = await conn.execute(
      `SELECT terminal_id, lat, lng
       FROM terminals
       ORDER BY terminal_id ASC`
    );

    // enforce 2 terminals logic
    if (!terminals || terminals.length !== 2) {
      await conn.rollback();
      return res.status(400).json({
        message: "Terminal config invalid. Expected exactly 2 active terminals.",
        active_terminals: terminals?.length ?? 0,
      });
    }

    // get latest GPS per device (from gps_logs)
    const [gpsRows] = await conn.execute(
      `
      SELECT gl.device_id, gl.lat, gl.lng
      FROM gps_logs gl
      JOIN (
        SELECT device_id, MAX(recorded_at) AS max_time
        FROM gps_logs
        GROUP BY device_id
      ) last
        ON last.device_id = gl.device_id
       AND last.max_time = gl.recorded_at
      `
    );

    let updated = 0;
    const results = [];

    for (const row of gpsRows) {
      const lat = toNum(row.lat);
      const lng = toNum(row.lng);
      if (lat == null || lng == null) continue;

      const r = await updateOne({
        conn,
        deviceId: row.device_id,
        lat,
        lng,
        terminals,
        arrivalM,
        departM,
      });

      updated++;
      results.push(r);
    }

    await conn.commit();
    return res.json({
      message: "Terminal state recomputed",
      updated_devices: updated,
      arrival_m: arrivalM,
      depart_m: departM,
    });
  } catch (err) {
    await conn.rollback();
    console.error("recomputeTerminalState error:", err);
    return res.status(500).json({ message: "Failed to recompute terminal state", error: err.message });
  } finally {
    conn.release();
  }
}

module.exports = {
  getTerminalStateSummary,
  getTerminalStateDevices,
  recomputeTerminalState,
   updateOne,
};