// services/terminalStateService.js
// - Computes terminal proximity & direction (2 terminals logic)
// - Fixes bug: bus "stuck" at terminal by checking distance to CURRENT terminal when wasAt=1

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
 * FIX: when wasAt=1, use distance to CURRENT terminal (not nearest)
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

  // distance to CURRENT terminal (if known)
  let distToCurrent = null;
  if (current_terminal_id) {
    const cur = terminals.find((t) => t.terminal_id === current_terminal_id);
    if (cur) {
      distToCurrent = haversineMeters(lat, lng, Number(cur.lat), Number(cur.lng));
    }
  }

  if (wasAt) {
    // ✅ stay/leave based on distance to current terminal (prevents "stuck" bug)
    if (distToCurrent != null && distToCurrent <= departM) {
      at_terminal = 1;
      target_terminal_id = otherTerminalId(terminals, current_terminal_id);
    } else {
      at_terminal = 0;
      if (current_terminal_id) {
        target_terminal_id = otherTerminalId(terminals, current_terminal_id);
      }
    }
  } else {
    // ✅ enter based on nearest terminal
    if (nearest && best <= arrivalM) {
      at_terminal = 1;
      current_terminal_id = nearest.terminal_id;
      target_terminal_id = otherTerminalId(terminals, current_terminal_id);
    } else {
      at_terminal = 0;
      if (current_terminal_id) {
        target_terminal_id = otherTerminalId(terminals, current_terminal_id);
      }
    }
  }

  // store distance to nearest terminal (useful for UI)
  const dist_m = best;

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
    [deviceId, current_terminal_id, target_terminal_id, at_terminal, dist_m]
  );

  return { deviceId, current_terminal_id, target_terminal_id, at_terminal, dist_m };
}

/**
 * Update terminal state for ONE device using SAME conn/transaction
 */
async function updateTerminalStateForDevice({
  conn,
  deviceId,
  lat,
  lng,
  arrivalM = 120,
  departM = 180,
}) {
  const latN = toNum(lat);
  const lngN = toNum(lng);
  if (latN == null || lngN == null) return null;

  // 2 terminals only
  const [terminals] = await conn.execute(
    `SELECT terminal_id, lat, lng
     FROM terminals
     WHERE is_active = 1
     ORDER BY terminal_id ASC`
  );

  if (!terminals || terminals.length !== 2) {
    // Skip if terminal config is wrong
    return null;
  }

  return updateOne({
    conn,
    deviceId,
    lat: latN,
    lng: lngN,
    terminals,
    arrivalM,
    departM,
  });
}

module.exports = { updateTerminalStateForDevice };