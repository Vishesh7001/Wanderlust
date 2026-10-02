const assert = require("node:assert/strict");
const test = require("node:test");
const { createRecommendationService } = require("../services/recommendationService.js");

function makeQuery(value) {
  return {
    select() { return this; },
    sort() { return this; },
    limit() { return this; },
    async lean() { return value; },
  };
}

function setup({ listings, user = { _id: "guest", wishlist: [] }, bookings = [], ratings = [] }) {
  const calls = { listingQueries: [], bookingQuery: null, privateQueries: 0 };
  const ListingModel = {
    find(query) {
      calls.listingQueries.push(query);
      let result = listings;
      if (query._id?.$in) result = listings.filter((listing) => query._id.$in.map(String).includes(String(listing._id)));
      if (query._id?.$nin) result = listings.filter((listing) => !query._id.$nin.map(String).includes(String(listing._id)));
      return makeQuery(result.filter((listing) => listing.isActive !== false));
    },
  };
  const UserModel = {
    findById(id) {
      calls.privateQueries += 1;
      assert.equal(id, user?._id);
      return { select: () => makeQuery(user) };
    },
  };
  const BookingModel = {
    find(query) {
      calls.privateQueries += 1;
      calls.bookingQuery = query;
      return makeQuery(bookings);
    },
  };
  const ReviewModel = {
    async aggregate() {
      return ratings;
    },
  };
  return {
    service: createRecommendationService({ ListingModel, UserModel, BookingModel, ReviewModel }),
    calls,
  };
}

const goaSavedStay = {
  _id: "saved-goa",
  title: "Saved Goa Villa",
  location: "Goa",
  country: "India",
  propertyType: "Villa",
  price: 4500,
  bedrooms: 2,
  amenities: ["Wifi", "Pool"],
};

test("cold-start recommendations use real listings and guest ratings without private activity", async () => {
  const highRated = { _id: "rated", title: "Rated Stay", location: "Lisbon", createdAt: new Date() };
  const newer = { _id: "new", title: "New Stay", location: "Kyoto", createdAt: new Date(Date.now() + 1000) };
  const { service, calls } = setup({
    listings: [newer, highRated],
    user: null,
    ratings: [{ _id: "rated", average: 4.9, count: 3 }, { _id: "new", average: 4.2, count: 1 }],
  });

  const result = await service.getRecommendations();

  assert.equal(result.personalized, false);
  assert.equal(result.title, "Popular stays you may like");
  assert.equal(result.items[0].listing, highRated);
  assert.match(result.items[0].reason, /Highly rated/);
  assert.equal(calls.privateQueries, 0);
});

test("wishlist location, type, amenities, price, and bedrooms influence ranking", async () => {
  const matching = {
    _id: "goa-match", title: "Goa Villa", location: "Goa", country: "India",
    propertyType: "Villa", price: 4700, bedrooms: 2, amenities: ["Wifi", "Pool"],
  };
  const weaker = {
    _id: "other", title: "City Apartment", location: "Tokyo", country: "Japan",
    propertyType: "Apartment", price: 9000, bedrooms: 1, amenities: ["Elevator"],
  };
  const { service, calls } = setup({
    listings: [goaSavedStay, matching, weaker],
    user: { _id: "guest", wishlist: ["saved-goa"] },
  });

  const result = await service.getRecommendations("guest");

  assert.equal(result.personalized, true);
  assert.equal(result.items[0].listing, matching);
  assert.match(result.items[0].reason, /Goa|villa|Wifi|Pool/i);
  assert.deepEqual(calls.listingQueries[1]._id.$nin, ["saved-goa"]);
  assert.equal(calls.bookingQuery.user, "guest");
});

test("confirmed and completed bookings contribute private user preference signals", async () => {
  const bookedListing = {
    _id: "past-booking", location: "Banff", country: "Canada", propertyType: "Cabin",
    price: 3200, bedrooms: 3, amenities: ["Fireplace", "Parking"],
  };
  const similar = {
    _id: "similar-cabin", location: "Banff", country: "Canada", propertyType: "Cabin",
    price: 3400, bedrooms: 3, amenities: ["Fireplace"],
  };
  const other = {
    _id: "different", location: "Miami", country: "United States", propertyType: "Apartment",
    price: 7000, bedrooms: 1, amenities: ["Wifi"],
  };
  const { service } = setup({
    listings: [bookedListing, similar, other],
    user: { _id: "guest", wishlist: [] },
    bookings: [{ listing: "past-booking", bookingStatus: "COMPLETED" }],
  });

  const result = await service.getRecommendations("guest");

  assert.equal(result.personalized, true);
  assert.equal(result.items[0].listing, similar);
  assert.match(result.items[0].reason, /Banff|cabin|Fireplace/i);
});

test("recent AI search signals influence location, budget, amenity, and explanation", async () => {
  const goaVilla = {
    _id: "goa-villa", title: "A quiet pool villa", location: "Goa", country: "India",
    propertyType: "Villa", price: 4200, bedrooms: 2, amenities: ["Wifi", "Pool"],
    description: "A quiet beach stay.",
  };
  const expensiveCityApartment = {
    _id: "city-apartment", title: "City apartment", location: "Tokyo", country: "Japan",
    propertyType: "Apartment", price: 9500, bedrooms: 1, amenities: ["Elevator"],
    description: "A central apartment.",
  };
  const { service } = setup({
    listings: [goaVilla, expensiveCityApartment],
    user: { _id: "guest", wishlist: [] },
  });

  const result = await service.getRecommendations("guest", [{
    location: "Goa",
    minPrice: 3000,
    maxPrice: 5000,
    propertyType: "Villa",
    amenities: ["Wifi", "Pool"],
    preferences: ["quiet beach"],
    bedrooms: 2,
    recordedAt: new Date().toISOString(),
  }]);

  assert.equal(result.personalized, true);
  assert.equal(result.items[0].listing, goaVilla);
  assert.match(result.items[0].reason, /recent searches/);
});

test("falls back to popular recommendations when every matching listing was already visited", async () => {
  const visited = { ...goaSavedStay, _id: "saved-goa" };
  const { service } = setup({
    listings: [visited],
    user: { _id: "guest", wishlist: ["saved-goa"] },
    ratings: [{ _id: "saved-goa", average: 4.7, count: 4 }],
  });

  const result = await service.getRecommendations("guest");

  assert.equal(result.personalized, false);
  assert.equal(result.title, "Popular stays you may like");
  assert.equal(result.items[0].listing, visited);
});

test("only actual active MongoDB listings can be recommended", async () => {
  const inactive = { _id: "inactive", isActive: false, title: "Inactive Stay" };
  const active = { _id: "active", isActive: true, title: "Active Stay" };
  const { service } = setup({ listings: [inactive, active], user: null });

  const result = await service.getRecommendations();

  assert.deepEqual(result.items.map((item) => item.listing._id), ["active"]);
});
