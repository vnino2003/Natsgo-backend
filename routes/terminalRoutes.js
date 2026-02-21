// routes/admin/terminalRoutes.js
const express = require("express");
const router = express.Router();

const {
  getAdminTerminals,
  getTerminalById,
  createTerminal,
  updateTerminal,
  deleteTerminal,
} = require("../controllers/terminalController");

// list
router.get("/", getAdminTerminals);

// create
router.post("/", createTerminal);

// read one
router.get("/:id", getTerminalById);

// update
router.put("/:id", updateTerminal);

// delete
router.delete("/:id", deleteTerminal);

module.exports = router;
