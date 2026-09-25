const express = require("express");
const mongoose = require("mongoose");
const Listing = require("../models/listing.js");
const Review = require("../models/review.js");
const { requireLogin } = require("../middleware/auth.js");

const router = express.Router();

router.get("/listings/:listingId/reviews", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.listingId)) {
      return res.status(400).json({ error: "Invalid listing id." });
    }

    const reviews = await Review.find({ listing: req.params.listingId })
      .populate("user", "username")
      .sort({ createdAt: -1 });
    res.json({ reviews });
  } catch (err) {
    res.status(500).json({ error: "Unable to load reviews." });
  }
});

router.post("/listings/:listingId/reviews", requireLogin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.listingId)) {
      return res.status(400).json({ error: "Invalid listing id." });
    }

    const { rating, comment } = req.body;
    const parsedRating = Number(rating);
    if (!Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 5) {
      return res.status(400).json({ error: "Rating must be between 1 and 5." });
    }
    if (!comment || String(comment).trim().length < 2) {
      return res.status(400).json({ error: "Please write a review." });
    }

    const listing = await Listing.findById(req.params.listingId).select("_id");
    if (!listing) {
      return res.status(404).json({ error: "Listing not found." });
    }

    const review = await Review.create({
      user: req.user._id,
      listing: listing._id,
      rating: parsedRating,
      comment: String(comment).trim(),
    });
    await review.populate("user", "username");
    res.status(201).json({ review });
  } catch (err) {
    res.status(500).json({ error: "Unable to save review." });
  }
});

router.delete("/reviews/:reviewId", requireLogin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.reviewId)) {
      return res.status(400).json({ error: "Invalid review id." });
    }

    const review = await Review.findById(req.params.reviewId);
    if (!review) {
      return res.status(404).json({ error: "Review not found." });
    }
    if (review.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "You can only delete your own reviews." });
    }

    await review.deleteOne();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Unable to delete review." });
  }
});

module.exports = router;
