// routes/admin/busRoutes.js
const express = require("express");
const router = express.Router();

const {
  getBuses,
  getBusById,
  createBus,
  updateBus,
  deleteBus,
} = require("../../controllers/busController");

// list
router.get("/", getBuses);

// create
router.post("/", createBus);

// read one
router.get("/:id", getBusById);

// update
router.put("/:id", updateBus);

// delete
router.delete("/:id", deleteBus);

module.exports = router;
