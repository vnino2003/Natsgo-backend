const express = require("express");
const router = express.Router();

const {
  assignDevice,
  unassignDevice,
  getCurrentAssignments,
  getAssignmentHistory
} = require("../controllers/busAssignmentController");

router.get("/current", getCurrentAssignments);
router.get("/history", getAssignmentHistory);

router.post("/assign", assignDevice);
router.post("/unassign", unassignDevice);

module.exports = router;
