const express = require("express");
const mongoose = require("mongoose");
const { requireLogin } = require("../middleware/auth.js");
const {
  createHostAssistantService,
  HostAssistantError,
} = require("../services/ai/hostAssistantService.js");
const { createTravelSearchService, TravelSearchError } = require("../services/ai/travelSearchService.js");

const router = express.Router();
const travelSearch = createTravelSearchService();
const hostAssistant = createHostAssistantService();

router.post("/host/listing-draft/generate", requireLogin, async (req, res) => {
  try {
    const content = await hostAssistant.generateDraftContent(req.body?.listing, req.body?.task);
    res.json(content);
  } catch (error) {
    handleHostAssistantError(error, res);
  }
});

router.post("/host/listings/:listingId/generate", requireLogin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.listingId)) return res.status(400).json({ error: "Invalid listing id." });
  try {
    const content = await hostAssistant.generateListingContent(req.user._id, req.params.listingId, req.body?.task);
    res.json(content);
  } catch (error) {
    handleHostAssistantError(error, res);
  }
});

router.get("/host/listings/:listingId/quality", requireLogin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.listingId)) return res.status(400).json({ error: "Invalid listing id." });
  try {
    const analysis = await hostAssistant.analyzeQuality(req.user._id, req.params.listingId);
    res.json(analysis);
  } catch (error) {
    handleHostAssistantError(error, res);
  }
});

router.post("/host/listings/:listingId/assistant", requireLogin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.listingId)) return res.status(400).json({ error: "Invalid listing id." });
  try {
    const result = await hostAssistant.answerHostQuestion(req.user._id, req.params.listingId, req.body?.question);
    res.json(result);
  } catch (error) {
    handleHostAssistantError(error, res);
  }
});

router.post("/host/listings/:listingId/analyze-photos", requireLogin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.listingId)) return res.status(400).json({ error: "Invalid listing id." });
  try {
    const analysis = await hostAssistant.analyzePhotos(req.user._id, req.params.listingId);
    res.json(analysis);
  } catch (error) {
    handleHostAssistantError(error, res);
  }
});

router.post("/travel-search", async (req, res) => {
  try {
    const result = await travelSearch.search(req.body?.message, req.body?.conversation);
    if (req.user && req.session) {
      const searchSignal = normalizeSearchSignal(result.filters);
      if (searchSignal) {
        const previousSearches = Array.isArray(req.session.recommendationSearches)
          ? req.session.recommendationSearches
          : [];
        req.session.recommendationSearches = [
          ...previousSearches.slice(-9),
          { ...searchSignal, recordedAt: new Date().toISOString() },
        ];
      }
    }
    res.json({
      message: result.message,
      filters: result.filters,
      listings: result.listings.map(serializeListing),
      followUpQuestion: result.followUpQuestion,
      availabilityChecked: result.availabilityChecked,
    });
  } catch (error) {
    if (error instanceof TravelSearchError) return res.status(error.status).json({ error: error.message });
    res.status(500).json({ error: "Unable to search stays right now. Please try again." });
  }
});

function handleHostAssistantError(error, res) {
  if (error instanceof HostAssistantError) return res.status(error.status).json({ error: error.message });
  console.error("[host-assistant] Request failed.", { errorType: error.name || "unknown" });
  res.status(500).json({ error: "Unable to complete the host assistant request." });
}

function normalizeSearchSignal(filters) {
  if (!filters || typeof filters !== "object") return null;
  const signal = {};
  for (const field of ["location", "country", "propertyType"]) {
    if (typeof filters[field] === "string" && filters[field].trim()) signal[field] = filters[field].trim().slice(0, 100);
  }
  for (const field of ["minPrice", "maxPrice", "bedrooms", "bathrooms"]) {
    if (Number.isFinite(filters[field])) signal[field] = filters[field];
  }
  for (const field of ["amenities", "preferences"]) {
    if (Array.isArray(filters[field])) {
      signal[field] = filters[field]
        .filter((value) => typeof value === "string" && value.trim())
        .slice(0, 10)
        .map((value) => value.trim().slice(0, 60));
    }
  }
  const meaningful = Object.values(signal).some((value) => Array.isArray(value) ? value.length > 0 : true);
  return meaningful ? signal : null;
}

function serializeListing(listing) {
  return {
    id: String(listing._id),
    title: listing.title,
    location: listing.location,
    country: listing.country,
    price: listing.price,
    image: listing.image,
    images: listing.images,
    propertyType: listing.propertyType,
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms,
    maxGuests: listing.maxGuests,
    amenities: listing.amenities,
  };
}

module.exports = router;
