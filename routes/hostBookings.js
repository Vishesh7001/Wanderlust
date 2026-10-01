const express = require("express");
const Listing = require("../models/listing.js");
const Booking = require("../models/booking.js");
const { requireLogin } = require("../middleware/auth.js");

const router = express.Router();

router.get("/", requireLogin, async (req, res) => {
  try {
    const listings = await Listing.find({ owner: req.user._id }).select("_id");
    const bookings = await Booking.find({ listing: { $in: listings.map((listing) => listing._id) } })
      .populate("listing", "title location country image images isActive")
      .populate("user", "name username email")
      .sort({ checkIn: 1 });
    res.json({ bookings });
  } catch (error) {
    res.status(500).json({ error: "Unable to load bookings for your listings." });
  }
});

module.exports = router;