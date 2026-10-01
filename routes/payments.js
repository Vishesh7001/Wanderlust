const express = require("express");
const mongoose = require("mongoose");
const Booking = require("../models/booking.js");
const { requireLogin } = require("../middleware/auth.js");
const { isMockPaymentEnabled, processTestPayment } = require("../services/payment/mockPaymentService.js");

const router = express.Router();

router.post("/verify", requireLogin, async (req, res) => {
  const { bookingId, orderId, outcome } = req.body || {};
  if (!mongoose.isValidObjectId(bookingId) || !orderId || !outcome) {
    return res.status(400).json({ error: "Test payment details are incomplete." });
  }
  if (!isMockPaymentEnabled()) return res.status(503).json({ error: "Test checkout is disabled in production." });

  try {
    const booking = await Booking.findOne({ _id: bookingId, user: req.user._id });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    if (booking.bookingStatus === "CONFIRMED" && booking.paymentStatus === "PAID" && booking.paymentOrderId === orderId) {
      return res.json({ success: true, bookingId: booking._id, paymentId: booking.paymentId, message: "Test payment was already processed." });
    }
    if (booking.paymentProvider !== "DEMO" || booking.bookingStatus !== "PENDING" || booking.paymentStatus !== "PENDING" || booking.paymentOrderId !== orderId) {
      return res.status(409).json({ error: "This test payment order is no longer active." });
    }
    if (!booking.paymentExpiresAt || booking.paymentExpiresAt <= new Date()) {
      booking.bookingStatus = "CANCELLED";
      booking.paymentStatus = "FAILED";
      booking.cancelledAt = new Date();
      await booking.save();
      return res.status(410).json({ error: "The payment window expired. Start a new booking." });
    }

    const verification = processTestPayment({
      bookingId: booking._id,
      orderId,
      expectedOrderId: booking.paymentOrderId,
      expectedAmount: booking.totalPrice * 100,
      amount: Number(req.body.amount),
      outcome,
    });
    if (!verification.verified) return res.status(400).json({ error: verification.error });
    if (verification.outcome !== "success") {
      booking.bookingStatus = "CANCELLED";
      booking.paymentStatus = verification.outcome === "cancel" ? "CANCELLED" : "FAILED";
      booking.cancelledAt = new Date();
      await booking.save();
      return res.json({ success: false, bookingId: booking._id, paymentStatus: booking.paymentStatus, message: "Test payment was not completed. The booking has not been confirmed." });
    }

    const confirmed = await Booking.findOneAndUpdate(
      { _id: booking._id, user: req.user._id, paymentOrderId: orderId, bookingStatus: "PENDING", paymentStatus: "PENDING" },
      { $set: { bookingStatus: "CONFIRMED", paymentStatus: "PAID", paymentId: verification.paymentId, paymentExpiresAt: null } },
      { new: true }
    );
    if (!confirmed) {
      const current = await Booking.findById(booking._id);
      if (current?.bookingStatus === "CONFIRMED" && current.paymentOrderId === orderId) {
        return res.json({ success: true, bookingId: current._id, message: "Payment was already verified." });
      }
      return res.status(409).json({ error: "This booking changed while payment was being verified." });
    }
    res.json({ success: true, bookingId: confirmed._id, paymentId: confirmed.paymentId, message: "Test payment complete. Booking confirmed." });
  } catch (error) {
    res.status(500).json({ error: "Unable to complete the demo payment. The booking is not confirmed." });
  }
});

module.exports = router;