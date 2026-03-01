// routes/admin/routeRoutes.js
const express = require("express");
const router = express.Router();

const {
  getAdminRoutes,
  getRouteById,
  createRoute,
  updateRoute,
  deleteRoute,
} = require("../controllers/routeController");

// list
router.get("/", getAdminRoutes);

// create
router.post("/", createRoute);

// read one
router.get("/:id", getRouteById);

// update
router.put("/:id", updateRoute);

// delete
router.delete("/:id", deleteRoute);

module.exports = router;