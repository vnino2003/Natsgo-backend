// routes/gpsRoutes.js
const express = require("express");
const router = express.Router();
const { postTelemetry } = require("../controllers/gpsController");

router.post("/telemetry", postTelemetry);

module.exports = router;
