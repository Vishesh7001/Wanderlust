const express = require("express");
const mongoose = require("mongoose");
const Listing = require("../models/listing.js");
const User = require("../models/user.js");
const { requireLogin } = require("../middleware/auth.js");

const router = express.Router();

router.get("/", requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate({
      path: "wishlist",
      options: { sort: { createdAt: -1 } },
    });
    res.json({ listings: user.wishlist });
  } catch (error) {
    res.status(500).json({ error: "Unable to load your wishlist." });
  }
});

router.post("/:listingId", requireLogin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.listingId)) return res.status(400).json({ error: "Invalid listing id." });
  try {
    const listing = await Listing.findOne({ _id: req.params.listingId, isActive: { $ne: false } }).select("_id");
    if (!listing) return res.status(404).json({ error: "Listing not found." });
    await User.updateOne({ _id: req.user._id }, { $addToSet: { wishlist: listing._id } });
    res.json({ saved: true, listingId: listing._id });
  } catch (error) {
    res.status(500).json({ error: "Unable to save this listing." });
  }
});

router.delete("/:listingId", requireLogin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.listingId)) return res.status(400).json({ error: "Invalid listing id." });
  try {
    await User.updateOne({ _id: req.user._id }, { $pull: { wishlist: req.params.listingId } });
    res.json({ saved: false, listingId: req.params.listingId });
  } catch (error) {
    res.status(500).json({ error: "Unable to remove this listing from your wishlist." });
  }
});

module.exports = router;