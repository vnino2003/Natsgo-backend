require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();

// --- CORS (Vercel + local) ---
const allowlist = String(process.env.CORS_ORIGIN || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// If you forget to set CORS_ORIGIN, we allow all (dev-friendly). For prod, set it.
app.use(
  cors({
    origin: (origin, cb) => {
      // allow non-browser requests (curl/postman) with no origin
      if (!origin) return cb(null, true);

      // allow any origin in dev if allowlist empty
      if (allowlist.length === 0) return cb(null, true);

      if (allowlist.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);

app.use(express.json());

// Render health check
app.get("/health", (req, res) => res.status(200).send("ok"));

app.get("/", (req, res) => {
  res.send({ message: "Natsgo Backend API running..." });
});

// Routes
const gpsRoutes = require("./routes/gpsRoutes");
const deviceRoutes = require("./routes/admin/deviceRoutes");
const busRoutes = require("./routes/admin/busRoutes");
const liveTrackRoutes = require("./routes/admin/liveTrackRoutes");
const busAssignmentRoutes = require("./routes/busAssignmentRoutes");
const trackRoutes = require("./routes/trackRoutes");
const terminalRoutes = require("./routes/terminalRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const terminalStateRoutes = require("./routes/admin/terminalStateRoutes");
const adminRoutes = require("./routes/routeRoutes");

const { startOfflineDevicesCron } = require("./jobs/offlineDevicesJob");

// API mounts
app.use("/api/gps", gpsRoutes);
app.use("/api/admin/devices", deviceRoutes);
app.use("/api/admin/buses", busRoutes);
app.use("/api/admin/bus-assignments", busAssignmentRoutes);
app.use("/api/track", trackRoutes);
app.use("/api/admin/terminals", terminalRoutes);
app.use("/api/admin/notifications", notificationRoutes);
app.use("/api/admin/track", liveTrackRoutes);
app.use("/api/admin/terminal-state", terminalStateRoutes);
app.use("/api/admin/routes", adminRoutes);

startOfflineDevicesCron();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
});