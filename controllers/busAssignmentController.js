const db = require("../db");

// POST /api/admin/bus-assignments/assign
// body: { bus_id, device_id, note }
async function assignDevice(req, res) {
  const { bus_id, device_id, note } = req.body;

  if (!bus_id || !device_id) {
    return res.status(400).json({ message: "bus_id and device_id are required" });
  }

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    // 1) verify bus exists
    const [busRows] = await conn.execute(
      "SELECT id, device_id FROM buses WHERE id = ? LIMIT 1",
      [bus_id]
    );
    if (!busRows[0]) {
      await conn.rollback();
      return res.status(404).json({ message: "Bus not found" });
    }
    const currentDeviceId = busRows[0].device_id;

    // 2) verify device exists
    const [devRows] = await conn.execute(
      "SELECT id FROM iot_devices WHERE id = ? LIMIT 1",
      [device_id]
    );
    if (!devRows[0]) {
      await conn.rollback();
      return res.status(404).json({ message: "Device not found" });
    }

    // 3) prevent device already assigned to another bus (current pointer)
    const [busyRows] = await conn.execute(
      "SELECT id, bus_code FROM buses WHERE device_id = ? AND id <> ? LIMIT 1",
      [device_id, bus_id]
    );
    if (busyRows[0]) {
      await conn.rollback();
      return res.status(409).json({
        message: `Device already assigned to bus ${busyRows[0].bus_code}`
      });
    }

    // 4) if bus currently has a device, close its active history row
    if (currentDeviceId) {
      await conn.execute(
        `
        UPDATE bus_device_assignments
        SET unassigned_at = NOW(), updated_at = NOW()
        WHERE bus_id = ? AND unassigned_at IS NULL
        `,
        [bus_id]
      );
    }

    // 5) also if this device has an active history assignment somewhere (safety)
    await conn.execute(
      `
      UPDATE bus_device_assignments
      SET unassigned_at = NOW(), updated_at = NOW()
      WHERE device_id = ? AND unassigned_at IS NULL
      `,
      [device_id]
    );

    // 6) set current pointer on buses table
    await conn.execute(
      "UPDATE buses SET device_id = ?, updated_at = NOW() WHERE id = ?",
      [device_id, bus_id]
    );

    // 7) insert history row
    const [ins] = await conn.execute(
      `
      INSERT INTO bus_device_assignments (bus_id, device_id, assigned_at, note)
      VALUES (?, ?, NOW(), ?)
      `,
      [bus_id, device_id, note || null]
    );

    await conn.commit();

    return res.status(201).json({
      message: "Device assigned",
      assignment_id: ins.insertId,
      bus_id,
      device_id
    });
  } catch (err) {
    await conn.rollback();
    console.error("assignDevice error:", err);
    return res.status(500).json({ message: "Failed to assign device", error: err.message });
  } finally {
    conn.release();
  }
}

// POST /api/admin/bus-assignments/unassign
// body: { bus_id, note }
async function unassignDevice(req, res) {
  const { bus_id, note } = req.body;
  if (!bus_id) return res.status(400).json({ message: "bus_id is required" });

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [busRows] = await conn.execute(
      "SELECT id, device_id FROM buses WHERE id = ? LIMIT 1",
      [bus_id]
    );
    if (!busRows[0]) {
      await conn.rollback();
      return res.status(404).json({ message: "Bus not found" });
    }

    const deviceId = busRows[0].device_id;
    if (!deviceId) {
      await conn.rollback();
      return res.status(409).json({ message: "Bus has no assigned device" });
    }

    // clear current pointer
    await conn.execute(
      "UPDATE buses SET device_id = NULL, updated_at = NOW() WHERE id = ?",
      [bus_id]
    );

    // close active assignment history
    await conn.execute(
      `
      UPDATE bus_device_assignments
      SET unassigned_at = NOW(),
          note = COALESCE(?, note),
          updated_at = NOW()
      WHERE bus_id = ? AND unassigned_at IS NULL
      `,
      [note || null, bus_id]
    );

    await conn.commit();
    return res.json({ message: "Device unassigned", bus_id });
  } catch (err) {
    await conn.rollback();
    console.error("unassignDevice error:", err);
    return res.status(500).json({ message: "Failed to unassign device", error: err.message });
  } finally {
    conn.release();
  }
}

// GET /api/admin/bus-assignments/current
async function getCurrentAssignments(req, res) {
  try {
    const [rows] = await db.execute(
      `
      SELECT
        b.id AS bus_id,
        b.bus_code,
        b.plate_no,
        b.capacity,
        b.bus_status,

        b.device_id,

        d.device_code,
        d.esp32_id,
        d.last_seen_at,
        d.gps_state,
        d.ir_state,
        d.ir_last_seen_at

      FROM buses b
      LEFT JOIN iot_devices d ON d.id = b.device_id
      ORDER BY b.bus_code ASC
      `
    );

    return res.json(rows);
  } catch (err) {
    console.error("getCurrentAssignments error:", err);
    return res.status(500).json({ message: "Failed to fetch assignments", error: err.message });
  }
}

// GET /api/admin/bus-assignments/history?bus_id=1 OR ?device_id=2
async function getAssignmentHistory(req, res) {
  const { bus_id, device_id } = req.query;

  try {
    let where = "1=1";
    const params = [];

    if (bus_id) {
      where += " AND bda.bus_id = ?";
      params.push(bus_id);
    }
    if (device_id) {
      where += " AND bda.device_id = ?";
      params.push(device_id);
    }

    const [rows] = await db.execute(
      `
      SELECT
        bda.id,
        bda.bus_id,
        b.bus_code,
        bda.device_id,
        d.device_code,
        bda.assigned_at,
        bda.unassigned_at,
        bda.note
      FROM bus_device_assignments bda
      JOIN buses b ON b.id = bda.bus_id
      JOIN iot_devices d ON d.id = bda.device_id
      WHERE ${where}
      ORDER BY bda.assigned_at DESC
      `,
      params
    );

    return res.json(rows);
  } catch (err) {
    console.error("getAssignmentHistory error:", err);
    return res.status(500).json({ message: "Failed to fetch history", error: err.message });
  }
}

module.exports = {
  assignDevice,
  unassignDevice,
  getCurrentAssignments,
  getAssignmentHistory
};
