// routes/commuterRoutes.js
const express = require("express");
const router = express.Router();
const { getLiveAssignedBuses } = require("../controllers/commuter/trackController");

// Commuter live tracking
router.get("/buses/live", getLiveAssignedBuses);

module.exports = router;
