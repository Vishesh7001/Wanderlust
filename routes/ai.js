const express = require("express");
const { createTravelSearchService, TravelSearchError } = require("../services/ai/travelSearchService.js");

const router = express.Router();
const travelSearch = createTravelSearchService();

router.post("/travel-search", async (req, res) => {
  try {
    const result = await travelSearch.search(req.body?.message, req.body?.conversation);
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
