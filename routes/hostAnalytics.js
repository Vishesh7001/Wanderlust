const express = require("express");
const mongoose = require("mongoose");
const {
  HostAnalyticsError,
  createAnalyticsInsightsService,
  createHostAnalyticsService,
} = require("../services/hostAnalyticsService.js");
const { requireLogin } = require("../middleware/auth.js");

const router = express.Router();
const analytics = createHostAnalyticsService();
const aiInsights = createAnalyticsInsightsService();

function requireHost(req, res, next) {
  if (!req.user || !["host", "admin"].includes(req.user.role)) {
    return res.status(req.user ? 403 : 401).json({
      error: req.user ? "Host access is required." : "You must be logged in to do that.",
    });
  }
  next();
}

function reportError(res, error, operation) {
  if (error instanceof HostAnalyticsError) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error(`[host-analytics] ${operation} failed.`, { errorType: error.name || "unknown" });
  return res.status(500).json({ error: `Unable to ${operation} right now.` });
}

function validListingId(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.listingId)) {
    return res.status(404).json({ error: "Listing not found." });
  }
  next();
}

router.use(requireLogin, requireHost);

router.get("/host/listings", async (req, res) => {
  try {
    const listings = await analytics.getHostListings(req.user._id);
    res.json({ listings });
  } catch (error) {
    reportError(res, error, "load your listings");
  }
});

router.get("/host/listings/:listingId", validListingId, async (req, res) => {
  try {
    const data = await analytics.getListingAnalytics(req.user._id, req.params.listingId, req.query.days || 30);
    res.json(data);
  } catch (error) {
    reportError(res, error, "load listing analytics");
  }
});

router.post("/host/listings/:listingId/insights", validListingId, async (req, res) => {
  try {
    const data = await analytics.getListingAnalytics(req.user._id, req.params.listingId, (req.body || {}).days || 30);
    const result = await aiInsights.generate(data);
    res.json(result);
  } catch (error) {
    reportError(res, error, "generate evidence-backed insights");
  }
});

router.post("/host/listings/:listingId/simulate-price", validListingId, async (req, res) => {
  const body = req.body || {};
  try {
    const result = await analytics.simulatePrice(
      req.user._id,
      req.params.listingId,
      body.days || 30,
      body.price
    );
    res.json(result);
  } catch (error) {
    reportError(res, error, "simulate the nightly price");
  }
});

router.post("/host/listings/:listingId/apply-price", validListingId, async (req, res) => {
  const body = req.body || {};
  if (body.confirmPriceChange !== true) {
    return res.status(400).json({ error: "Confirm the price change before applying it." });
  }
  try {
    const result = await analytics.applyPrice(req.user._id, req.params.listingId, body.price);
    res.json(result);
  } catch (error) {
    reportError(res, error, "apply the confirmed price");
  }
});

module.exports = { requireHost, router };
