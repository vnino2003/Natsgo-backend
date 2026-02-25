// routes/admin/terminalStateRoutes.js
const express = require("express");
const router = express.Router();

const {
  getTerminalStateSummary,
  getTerminalStateDevices,
  recomputeTerminalState,
} = require("../../controllers/terminalStateController");

// router.use(requireAdmin);

router.get("/summary", getTerminalStateSummary);
router.get("/devices", getTerminalStateDevices);
router.post("/recompute", recomputeTerminalState);

module.exports = router;