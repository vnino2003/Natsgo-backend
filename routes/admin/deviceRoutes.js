// routes/admin/deviceRoutes.js
const express = require("express");
const router = express.Router();

const { getDevices, getDeviceById } = require("../../controllers/deviceController");

router.get("/", getDevices);
router.get("/:id", getDeviceById);

module.exports = router;
