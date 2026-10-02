const Listing = require("../models/listing.js");
const User = require("../models/user.js");
const Booking = require("../models/booking.js");
const Review = require("../models/review.js");

const MAX_CANDIDATES = 120;
const MAX_BOOKING_SIGNALS = 30;
const RECOMMENDATION_LIMIT = 4;
const FEATURE_WEIGHTS = Object.freeze({
  location: 0.25,
  country: 0.06,
  price: 0.18,
  amenities: 0.15,
  propertyType: 0.15,
  bedrooms: 0.07,
  preferences: 0.08,
  rating: 0.08,
  recency: 0.02,
});

const listingFields = "_id title description location country propertyType price bedrooms bathrooms amenities image images owner createdAt";

function normalizeText(value) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

function referenceId(value) {
  return value && typeof value === "object" && value._id ? String(value._id) : String(value || "");
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((first, second) => first - second);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function average(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function bounded(value) {
  return Math.max(0, Math.min(1, value));
}

function scoreCandidate(listing, profile, rating, weights = FEATURE_WEIGHTS) {
  const featureScores = {};
  const place = normalizeText(listing.location);
  const country = normalizeText(listing.country);
  const propertyType = normalizeText(listing.propertyType);

  if (place && profile.locations.size) featureScores.location = profile.locations.get(place) || 0;
  if (place && profile.searchLocations.size) {
    featureScores.location = Math.max(featureScores.location || 0, profile.searchLocations.has(place) ? 1 : 0);
  }
  if (country && (profile.countries.size || profile.searchCountries.size)) {
    featureScores.country = Math.max(profile.countries.get(country) || 0, profile.searchCountries.has(country) ? 1 : 0);
  }
  if (profile.medianPrice && Number.isFinite(listing.price)) {
    const ratio = Math.abs(Math.log(listing.price / profile.medianPrice));
    featureScores.price = bounded(1 - ratio / Math.log(3));
  }
  if (Array.isArray(listing.amenities) && (profile.amenities.size || profile.searchAmenities.size)) {
    const preferredAmenities = new Set([...profile.amenities, ...profile.searchAmenities]);
    const matches = listing.amenities.filter((amenity) => profile.amenities.has(normalizeText(amenity))).length;
    const searchMatches = listing.amenities.filter((amenity) => profile.searchAmenities.has(normalizeText(amenity))).length;
    featureScores.amenities = bounded(Math.max(matches, searchMatches) / Math.min(3, preferredAmenities.size));
  }
  if (propertyType && (profile.propertyTypes.size || profile.searchPropertyTypes.size)) {
    featureScores.propertyType = Math.max(
      profile.propertyTypes.get(propertyType) || 0,
      profile.searchPropertyTypes.has(propertyType) ? 1 : 0
    );
  }
  if (Number.isFinite(listing.bedrooms) && profile.bedroomCounts.length) {
    featureScores.bedrooms = average(profile.bedroomCounts.map((bedrooms) => 1 / (1 + Math.abs(bedrooms - listing.bedrooms))));
  }
  if (profile.searchPreferences.size) {
    const listingText = normalizeText([
      listing.title,
      listing.description,
      ...(listing.amenities || []),
    ].filter(Boolean).join(" "));
    const matchedPreferences = [...profile.searchPreferences].filter((preference) => {
      const words = preference.split(/\s+/).filter((word) => word.length > 2);
      return listingText.includes(preference) || (words.length > 0 && words.every((word) => listingText.includes(word)));
    }).length;
    featureScores.preferences = bounded(matchedPreferences / profile.searchPreferences.size);
  }
  featureScores.rating = bounded((rating.average - 1) / 4);
  const createdAt = listing.createdAt ? new Date(listing.createdAt).getTime() : Number.NaN;
  const ageDays = Number.isFinite(createdAt) ? Math.max(0, (Date.now() - createdAt) / 86400000) : 365;
  featureScores.recency = bounded(1 - ageDays / 365);

  const availableWeight = Object.entries(featureScores)
    .reduce((total, [feature, value]) => total + (Number.isFinite(value) ? weights[feature] || 0 : 0), 0);
  const relevance = availableWeight
    ? Object.entries(featureScores).reduce((total, [feature, value]) => total + value * (weights[feature] || 0), 0) / availableWeight
    : 0;
  return { relevance, featureScores };
}

function buildReasons(listing, profile, featureScores) {
  const reasons = [];
  if (featureScores.location >= 0.5) {
    reasons.push(profile.searchLocations.has(normalizeText(listing.location))
      ? `Matches a destination in your recent searches: ${listing.location}.`
      : `In ${listing.location}, where you saved or booked a stay.`);
  }
  if (featureScores.propertyType >= 0.5 && listing.propertyType && listing.propertyType !== "Other") {
    reasons.push(profile.searchPropertyTypes.has(normalizeText(listing.propertyType))
      ? `Matches a property type in your recent searches: ${listing.propertyType}.`
      : `A ${listing.propertyType.toLowerCase()} like stays in your activity.`);
  }
  const matchingAmenity = (listing.amenities || []).find((amenity) =>
    profile.amenities.has(normalizeText(amenity)) || profile.searchAmenities.has(normalizeText(amenity))
  );
  if (matchingAmenity && reasons.length < 2) {
    reasons.push(profile.searchAmenities.has(normalizeText(matchingAmenity))
      ? `Includes ${matchingAmenity}, which you searched for.`
      : `Offers ${matchingAmenity}, found in a stay you saved or booked.`);
  }
  const matchingSearchPreference = [...profile.searchPreferences].find((preference) => {
    const listingText = normalizeText([listing.title, listing.description, ...(listing.amenities || [])].filter(Boolean).join(" "));
    const words = preference.split(/\s+/).filter((word) => word.length > 2);
    return listingText.includes(preference) || (words.length > 0 && words.every((word) => listingText.includes(word)));
  });
  if (matchingSearchPreference && reasons.length < 2) {
    reasons.push(`Matches your recent search for ${matchingSearchPreference}.`);
  }
  const matchesSearchedPrice = profile.priceRanges.some(({ min, max }) =>
    (min === null || listing.price >= min) && (max === null || listing.price <= max)
  );
  if (matchesSearchedPrice && reasons.length < 2) reasons.push("Within a price range from your recent searches.");
  if (featureScores.price >= 0.75 && reasons.length < 2) reasons.push("Priced near stays you saved or booked.");
  if (!reasons.length) reasons.push("Shares features with stays you saved or booked.");
  return reasons.slice(0, 2);
}

function createRecommendationService({
  ListingModel = Listing,
  UserModel = User,
  BookingModel = Booking,
  ReviewModel = Review,
  weights = FEATURE_WEIGHTS,
} = {}) {
  async function getRecommendations(userId, searchSignals = []) {
    let profile = null;
    let excludedIds = [];
    let fallbackToGeneral = false;
    if (userId) {
      profile = await buildProfile(userId, searchSignals);
      excludedIds = [...profile.visitedIds];
    }

    let candidates = await loadCandidates(ListingModel, excludedIds);
    if (!candidates.length && excludedIds.length) {
      candidates = await loadCandidates(ListingModel, []);
      fallbackToGeneral = true;
    }
    if (!candidates.length) {
      return { personalized: false, title: "Popular stays you may like", items: [] };
    }

    const ratings = await loadRatings(ReviewModel, candidates.map((listing) => listing._id));
    if (profile && profile.signalCount && !fallbackToGeneral) {
      const ranked = candidates.map((listing) => {
        const listingRating = ratings.get(String(listing._id)) || { average: 0, count: 0 };
        const score = scoreCandidate(listing, profile, listingRating, weights);
        return {
          listing,
          relevance: score.relevance,
          reasons: buildReasons(listing, profile, score.featureScores),
        };
      }).sort((first, second) =>
        second.relevance - first.relevance
        || (ratings.get(String(second.listing._id))?.average || 0) - (ratings.get(String(first.listing._id))?.average || 0)
        || new Date(second.listing.createdAt || 0) - new Date(first.listing.createdAt || 0)
      );

      return {
        personalized: true,
        title: "Recommended for You",
        items: diversify(ranked, RECOMMENDATION_LIMIT).map(({ listing, reasons }) => ({ listing, reason: reasons.join(" ") })),
      };
    }

    const ranked = candidates.map((listing) => ({
      listing,
      rating: ratings.get(String(listing._id)) || { average: 0, count: 0 },
    })).sort((first, second) =>
      second.rating.average - first.rating.average
      || second.rating.count - first.rating.count
      || new Date(second.listing.createdAt || 0) - new Date(first.listing.createdAt || 0)
    );
    return {
      personalized: false,
      title: "Popular stays you may like",
      items: diversify(ranked, RECOMMENDATION_LIMIT).map(({ listing, rating }) => ({
        listing,
        reason: rating.count ? `Highly rated by guests (${rating.average.toFixed(1)} from ${rating.count} ${rating.count === 1 ? "review" : "reviews"}).` : "A recently added stay to explore.",
      })),
    };
  }

  async function buildProfile(userId, searchSignals) {
    const user = await UserModel.findById(userId).select("wishlist").lean();
    if (!user) return emptyProfile();
    const normalizedSearches = normalizeSearchSignals(searchSignals);
    const wishlistIds = (user.wishlist || []).map(referenceId).filter(Boolean);
    const bookings = await BookingModel.find({
      user: userId,
      bookingStatus: { $in: ["CONFIRMED", "COMPLETED"] },
    }).select("listing bookingStatus").sort({ createdAt: -1 }).limit(MAX_BOOKING_SIGNALS).lean();

    const signalWeights = new Map();
    wishlistIds.forEach((id) => signalWeights.set(id, { weight: 1.5, source: "saved" }));
    for (const booking of bookings) {
      const id = referenceId(booking.listing);
      if (!id) continue;
      const existing = signalWeights.get(id);
      const bookingWeight = booking.bookingStatus === "COMPLETED" ? 3 : 2.5;
      if (!existing || bookingWeight > existing.weight) signalWeights.set(id, { weight: bookingWeight, source: "booked" });
    }
    if (!signalWeights.size && !normalizedSearches.length) return emptyProfile();

    const seedListings = signalWeights.size
      ? await ListingModel.find({ _id: { $in: [...signalWeights.keys()] } }).select(listingFields).lean()
      : [];
    if (!seedListings.length && !normalizedSearches.length) return emptyProfile();

    const profile = emptyProfile();
    const weights = { locations: new Map(), countries: new Map(), propertyTypes: new Map(), amenities: new Map() };
    for (const listing of seedListings) {
      const signal = signalWeights.get(String(listing._id));
      if (!signal) continue;
      profile.signalCount += signal.weight;
      profile.visitedIds.add(String(listing._id));
      profile.seedListings.push({ listing, source: signal.source });
      addWeight(weights.locations, listing.location, signal.weight);
      addWeight(weights.countries, listing.country, signal.weight);
      addWeight(weights.propertyTypes, listing.propertyType, signal.weight);
      (listing.amenities || []).forEach((amenity) => addWeight(weights.amenities, amenity, signal.weight));
      if (Number.isFinite(listing.price)) profile.prices.push(listing.price);
      if (Number.isFinite(listing.bedrooms)) profile.bedroomCounts.push(listing.bedrooms);
    }

    for (const signal of normalizedSearches) {
      profile.signalCount += 0.5;
      if (signal.location) profile.searchLocations.add(signal.location);
      if (signal.country) profile.searchCountries.add(signal.country);
      if (signal.propertyType) profile.searchPropertyTypes.add(signal.propertyType);
      signal.amenities.forEach((amenity) => profile.searchAmenities.add(amenity));
      signal.preferences.forEach((preference) => profile.searchPreferences.add(preference));
      if (signal.bedrooms !== null) profile.bedroomCounts.push(signal.bedrooms);
      if (signal.priceRange.min !== null || signal.priceRange.max !== null) {
        profile.priceRanges.push(signal.priceRange);
        const representativePrice = signal.priceRange.min !== null && signal.priceRange.max !== null
          ? (signal.priceRange.min + signal.priceRange.max) / 2
          : signal.priceRange.min ?? signal.priceRange.max;
        if (Number.isFinite(representativePrice) && representativePrice > 0) profile.prices.push(representativePrice);
      }
    }

    profile.locations = normalizedWeights(weights.locations);
    profile.countries = normalizedWeights(weights.countries);
    profile.propertyTypes = normalizedWeights(weights.propertyTypes);
    profile.amenities = new Set(weights.amenities.keys());
    profile.medianPrice = median(profile.prices);
    return profile;
  }

  return { getRecommendations };
}

function emptyProfile() {
  return {
    signalCount: 0,
    visitedIds: new Set(),
    seedListings: [],
    locations: new Map(),
    countries: new Map(),
    propertyTypes: new Map(),
    amenities: new Set(),
    searchLocations: new Set(),
    searchCountries: new Set(),
    searchPropertyTypes: new Set(),
    searchAmenities: new Set(),
    searchPreferences: new Set(),
    priceRanges: [],
    prices: [],
    medianPrice: null,
    bedroomCounts: [],
  };
}

function normalizeSearchSignals(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-10).filter((signal) => signal && typeof signal === "object").map((signal) => {
    const toValue = (candidate) => typeof candidate === "string" ? normalizeText(candidate) : "";
    const price = (candidate) => Number.isFinite(candidate) && candidate >= 0 ? candidate : null;
    return {
      location: toValue(signal.location),
      country: toValue(signal.country),
      propertyType: toValue(signal.propertyType),
      amenities: Array.isArray(signal.amenities) ? signal.amenities.map(toValue).filter(Boolean).slice(0, 10) : [],
      preferences: Array.isArray(signal.preferences) ? signal.preferences.map(toValue).filter(Boolean).slice(0, 8) : [],
      bedrooms: Number.isInteger(signal.bedrooms) && signal.bedrooms >= 0 ? signal.bedrooms : null,
      priceRange: { min: price(signal.minPrice), max: price(signal.maxPrice) },
    };
  }).filter((signal) =>
    signal.location || signal.country || signal.propertyType || signal.amenities.length || signal.preferences.length
    || signal.bedrooms !== null || signal.priceRange.min !== null || signal.priceRange.max !== null
  );
}

function addWeight(weights, value, weight) {
  const key = normalizeText(value);
  if (key) weights.set(key, (weights.get(key) || 0) + weight);
}

function normalizedWeights(weights) {
  const total = [...weights.values()].reduce((sum, value) => sum + value, 0);
  return new Map([...weights].map(([key, value]) => [key, total ? value / total : 0]));
}

async function loadCandidates(ListingModel, excludedIds) {
  const query = { isActive: { $ne: false } };
  if (excludedIds.length) query._id = { $nin: excludedIds };
  return ListingModel.find(query).select(listingFields).sort({ createdAt: -1 }).limit(MAX_CANDIDATES).lean();
}

async function loadRatings(ReviewModel, listingIds) {
  const rows = await ReviewModel.aggregate([
    { $match: { listing: { $in: listingIds } } },
    { $group: { _id: "$listing", average: { $avg: "$rating" }, count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), { average: row.average || 0, count: row.count || 0 }]));
}

function diversify(ranked, limit) {
  const selected = [];
  const remaining = [...ranked];
  const usedLocations = new Set();
  while (remaining.length && selected.length < limit) {
    let index = remaining.findIndex(({ listing }) => !usedLocations.has(normalizeText(listing.location)));
    if (index < 0) index = 0;
    const [item] = remaining.splice(index, 1);
    selected.push(item);
    const location = normalizeText(item.listing.location);
    if (location) usedLocations.add(location);
  }
  return selected;
}

module.exports = { FEATURE_WEIGHTS, createRecommendationService, scoreCandidate };
