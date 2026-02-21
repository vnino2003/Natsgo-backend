require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send({ message: "Natsgo Backend API running..." });
});

// Routes
const gpsRoutes = require("./routes/gpsRoutes");
const deviceRoutes = require("./routes/admin/deviceRoutes");
const busRoutes = require("./routes/admin/busRoutes");
const busAssignmentRoutes = require("./routes/busAssignmentRoutes");
const trackRoutes = require("./routes/trackRoutes");
const terminalRoutes = require("./routes/terminalRoutes");

// ESP32 telemetry (public/internal)
app.use("/api/gps", gpsRoutes);

// Admin devices page
app.use("/api/admin/devices", deviceRoutes);
app.use("/api/admin/buses", busRoutes);
app.use("/api/admin/bus-assignments", busAssignmentRoutes);
app.use("/api/track", trackRoutes);
app.use("/api/admin/terminals", terminalRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend running at http://localhost:${PORT}`));
