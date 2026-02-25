const express = require("express");
const router = express.Router();
const { getAdminLiveBuses } = require("../../controllers/admin/liveTrackingController");

// Admin Live Tracking
router.get("/buses/live", getAdminLiveBuses);

module.exports = router;