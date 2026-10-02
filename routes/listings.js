const express = require("express");
const mongoose = require("mongoose");
const Listing = require("../models/listing.js");
const User = require("../models/user.js");
const { requireLogin } = require("../middleware/auth.js");
const { listingImages } = require("../middleware/uploads.js");
const { deleteCloudinaryImage } = require("../cloudConfig.js");
const { buildFilters, getListingInput, validationMessage } = require("../utils/listingUtils.js");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const filters = buildFilters(req.query);
    if (filters.error) return res.status(400).json({ error: filters.error });

    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 48));
    const [listings, total] = await Promise.all([
      Listing.find(filters.query).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
      Listing.countDocuments(filters.query),
    ]);
    res.json({ listings, total, page, hasMore: page * limit < total });
  } catch (error) {
    res.status(500).json({ error: "Unable to search listings." });
  }
});

router.get("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid listing id." });
  try {
    const listing = await Listing.findOne({ _id: req.params.id, isActive: { $ne: false } }).populate("owner", "name username profileImage");
    if (!listing) return res.status(404).json({ error: "Listing not found." });
    res.json({ listing });
  } catch (error) {
    res.status(500).json({ error: "Unable to load this listing." });
  }
});

router.post("/", requireLogin, listingImages, async (req, res) => {
  try {
    const listing = new Listing({ ...getListingInput(req.body.listing || req.body, req.listingImages), owner: req.user._id });
    await listing.save();
    await User.updateOne({ _id: req.user._id, role: "user" }, { $set: { role: "host" } });
    res.status(201).json({ listing });
  } catch (error) {
    if (error.name === "ValidationError") return res.status(400).json({ error: validationMessage(error) });
    res.status(500).json({ error: "Unable to create this listing." });
  }
});

router.put("/:id", requireLogin, listingImages, updateListing);
router.patch("/:id", requireLogin, listingImages, updateListing);

async function updateListing(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid listing id." });
  try {
    const listing = await Listing.findOne({ _id: req.params.id, isActive: { $ne: false } });
    if (!listing) return res.status(404).json({ error: "Listing not found." });
    if (!listing.owner || listing.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "You can only edit listings you own." });
    }

    const fields = getListingInput(req.body.listing || req.body, req.listingImages);
    if (req.listingImages && req.listingImages.length > 0) {
      if (listing.image && typeof listing.image === "object" && listing.image.filename) {
        deleteCloudinaryImage(listing.image.filename);
      }
      if (Array.isArray(listing.images)) {
        for (const img of listing.images) {
          if (img && typeof img === "object" && img.filename) {
            deleteCloudinaryImage(img.filename);
          }
        }
      }
    }
    Object.assign(listing, fields);
    await listing.save();
    res.json({ listing });
  } catch (error) {
    if (error.name === "ValidationError") return res.status(400).json({ error: validationMessage(error) });
    res.status(500).json({ error: "Unable to update this listing." });
  }
}

router.delete("/:id", requireLogin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid listing id." });
  try {
    const listing = await Listing.findOne({ _id: req.params.id, isActive: { $ne: false } });
    if (!listing) return res.status(404).json({ error: "Listing not found." });
    if (!listing.owner || listing.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "You can only delete listings you own." });
    }
    listing.isActive = false;

    if (listing.image && typeof listing.image === "object" && listing.image.filename) {
      deleteCloudinaryImage(listing.image.filename);
    }
    if (Array.isArray(listing.images)) {
      for (const img of listing.images) {
        if (img && typeof img === "object" && img.filename) {
          deleteCloudinaryImage(img.filename);
        }
      }
    }

    await listing.save();
    await User.updateMany({ wishlist: listing._id }, { $pull: { wishlist: listing._id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Unable to delete this listing." });
  }
});

module.exports = router;