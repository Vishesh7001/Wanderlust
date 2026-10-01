const express = require("express");
const mongoose = require("mongoose");
const Booking = require("../models/booking.js");
const Listing = require("../models/listing.js");
const { requireLogin } = require("../middleware/auth.js");
const { calculatePrice, getGuestCount, getPaymentExpiresAt, getStay } = require("../utils/bookingUtils.js");
const { createTestOrder, isMockPaymentEnabled } = require("../services/payment/mockPaymentService.js");

const router = express.Router();
const activeStatuses = ["PENDING", "CONFIRMED"];

router.get("/availability", async (req, res) => {
  if (!mongoose.isValidObjectId(req.query.listingId)) return res.status(400).json({ error: "Choose a valid listing." });
  try {
    const listing = await Listing.findOne({ _id: req.query.listingId, isActive: { $ne: false } }).select("price maxGuests");
    if (!listing) return res.status(404).json({ error: "Listing not found." });

    const checkInValue = req.query.checkIn || req.query.from;
    const checkOutValue = req.query.checkOut || req.query.to;
    const stay = getStay(checkInValue, checkOutValue);
    if (stay.error) return res.status(400).json({ error: stay.error });
    const guestResult = req.query.guests === undefined ? {} : getGuestCount(req.query.guests, listing.maxGuests);
    if (guestResult.error) return res.status(400).json({ error: guestResult.error });

    await expirePendingBookings(listing._id);
    const overlaps = await Booking.find({
      listing: listing._id,
      bookingStatus: { $in: activeStatuses },
      reservedNightKeys: { $in: stay.nightKeys },
    }).select("reservedNightKeys");
    const blockedNights = [...new Set(overlaps.flatMap((booking) => booking.reservedNightKeys))]
      .filter((key) => stay.nightKeys.includes(key));
    const price = calculatePrice(listing.price, stay.nights);
    res.json({
      available: blockedNights.length === 0,
      message: blockedNights.length ? "This property is already booked for some of those dates." : "These dates are available.",
      unavailableDates: blockedNights,
      nights: stay.nights,
      ...price,
      maxGuests: listing.maxGuests || 2,
    });
  } catch (error) {
    res.status(500).json({ error: "Unable to check availability right now." });
  }
});

router.post("/", requireLogin, async (req, res) => {
  if (!isMockPaymentEnabled()) return res.status(503).json({ error: "Test checkout is disabled in production." });
  const { listingId, checkIn: checkInValue, checkOut: checkOutValue } = req.body || {};
  if (!mongoose.isValidObjectId(listingId)) return res.status(400).json({ error: "Choose a valid listing." });
  const stay = getStay(checkInValue, checkOutValue);
  if (stay.error) return res.status(400).json({ error: stay.error });

  try {
    const listing = await Listing.findOne({ _id: listingId, isActive: { $ne: false } });
    if (!listing) return res.status(404).json({ error: "Listing not found." });
    if (listing.owner && listing.owner.toString() === req.user._id.toString()) {
      return res.status(403).json({ error: "You cannot book your own listing." });
    }
    const guestResult = getGuestCount(req.body.guests, listing.maxGuests);
    if (guestResult.error) return res.status(400).json({ error: guestResult.error });

    await expirePendingBookings(listing._id);
    const overlap = await Booking.exists({
      listing: listing._id,
      bookingStatus: { $in: activeStatuses },
      reservedNightKeys: { $in: stay.nightKeys },
    });
    if (overlap) return res.status(409).json({ error: "This property is already booked for some of those dates." });

    const pricing = calculatePrice(listing.price, stay.nights);
    const paymentExpiresAt = getPaymentExpiresAt();
    const booking = new Booking({
      user: req.user._id,
      listing: listing._id,
      host: listing.owner || null,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      guests: guestResult.guests,
      nights: stay.nights,
      ...pricing,
      paymentExpiresAt,
      reservedNightKeys: stay.nightKeys,
    });

    await booking.save();
    try {
      const order = createTestOrder(pricing.totalPrice * 100);
      booking.paymentOrderId = order.id;
      await booking.save();
      res.status(201).json({
        booking: serializeBooking(booking),
        order: { id: order.id, amount: order.amount, currency: order.currency },
        paymentMode: "TEST PAYMENT - NO MONEY IS CHARGED",
      });
    } catch (paymentError) {
      booking.bookingStatus = "CANCELLED";
      booking.paymentStatus = "FAILED";
      booking.cancelledAt = new Date();
      await booking.save();
      res.status(502).json({ error: "Could not start payment. No booking was confirmed; please try again." });
    }
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: "Those dates were just reserved by another guest. Choose different dates." });
    if (error.name === "ValidationError") return res.status(400).json({ error: "Check the dates and guest count, then try again." });
    res.status(500).json({ error: "Unable to create this booking." });
  }
});

router.get("/my", requireLogin, async (req, res) => {
  try {
    const bookings = await Booking.find({ user: req.user._id })
      .populate("listing", "title location country image images isActive")
      .sort({ checkIn: -1 });
    res.json({ bookings: bookings.map(serializeBooking) });
  } catch (error) {
    res.status(500).json({ error: "Unable to load your trips." });
  }
});

router.get("/:id", requireLogin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid booking id." });
  try {
    const booking = await loadBooking(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    if (!canViewBooking(booking, req.user._id)) return res.status(403).json({ error: "You cannot view this booking." });
    res.json({ booking: serializeBooking(booking) });
  } catch (error) {
    res.status(500).json({ error: "Unable to load this booking." });
  }
});

router.post("/:id/cancel", requireLogin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid booking id." });
  try {
    const booking = await Booking.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id, bookingStatus: { $in: ["PENDING", "CONFIRMED"] }, cancellationRequestedAt: null },
      { $set: { cancellationRequestedAt: new Date() } },
      { new: true }
    );
    if (!booking) {
      const existing = await Booking.findOne({ _id: req.params.id, user: req.user._id }).select("bookingStatus");
      if (!existing) return res.status(404).json({ error: "Booking not found." });
      return res.status(409).json({ error: "This booking can no longer be cancelled." });
    }

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (booking.checkIn <= today) {
      await Booking.updateOne({ _id: booking._id }, { $unset: { cancellationRequestedAt: 1 } });
      return res.status(409).json({ error: "Bookings cannot be cancelled on or after check-in." });
    }

    if (booking.paymentStatus === "PAID" && booking.paymentProvider === "DEMO") {
      booking.paymentStatus = "REFUNDED";
    } else if (booking.paymentStatus === "PAID") {
      await Booking.updateOne({ _id: booking._id }, { $unset: { cancellationRequestedAt: 1 } });
      return res.status(409).json({ error: "This booking uses an unsupported payment provider for refunds." });
    } else {
      booking.paymentStatus = "CANCELLED";
    }

    booking.bookingStatus = "CANCELLED";
    booking.cancelledAt = new Date();
    booking.cancellationRequestedAt = undefined;
    await booking.save();
    res.json({ success: true, booking: serializeBooking(booking), message: "Booking cancelled." });
  } catch (error) {
    res.status(500).json({ error: "Unable to cancel this booking." });
  }
});

async function expirePendingBookings(listingId) {
  await Booking.updateMany(
    { listing: listingId, bookingStatus: "PENDING", paymentExpiresAt: { $lte: new Date() } },
    { $set: { bookingStatus: "CANCELLED", paymentStatus: "FAILED", cancelledAt: new Date() } }
  );
}

async function loadBooking(id) {
  return Booking.findById(id)
    .populate("listing", "title location country image images owner isActive")
    .populate("user", "name username email")
    .populate("host", "name username");
}

function canViewBooking(booking, userId) {
  return booking.user?._id?.toString() === userId.toString()
    || booking.host?._id?.toString() === userId.toString()
    || booking.listing?.owner?.toString() === userId.toString();
}

function serializeBooking(booking) {
  const result = booking.toObject ? booking.toObject() : booking;
  delete result.reservedNightKeys;
  delete result.cancellationRequestedAt;
  delete result.__v;
  return result;
}

module.exports = router;