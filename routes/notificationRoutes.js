// routes/notificationRoutes.js
const express = require("express");
const router = express.Router();

const {
  getAllNotifications,
  getNotificationSummary,
  setNotificationRead,
  resolveNotification,
    getNotificationPreview, // ✅ add
  deleteNotification,
  clearNotifications,
} = require("../controllers/notificationController");

// router.use(requireAdmin);

router.get("/", getAllNotifications);
router.get("/summary", getNotificationSummary);
router.get("/preview", getNotificationPreview); // ✅ add

router.patch("/:id/read", setNotificationRead);
router.patch("/:id/resolve", resolveNotification);  

// ✅ delete 1
router.delete("/:id", deleteNotification);

// ✅ clear bulk (default mode=resolved)
router.delete("/", clearNotifications);

module.exports = router;