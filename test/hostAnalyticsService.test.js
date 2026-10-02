const assert = require("node:assert/strict");
const express = require("express");
const ejsMate = require("ejs-mate");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const mongoose = require("mongoose");
const Booking = require("../models/booking.js");
const {
  HostAnalyticsError,
  analyzeAnomalies,
  createAnalyticsInsightsService,
  createHostAnalyticsService,
  getDateRange,
  summarizeComparables,
  summarizeDemand,
  validatePeriod,
} = require("../services/hostAnalyticsService.js");
const { requireHost, router } = require("../routes/hostAnalytics.js");

const now = new Date("2026-10-02T12:00:00.000Z");
const listingId = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();
const listing = {
  _id: listingId,
  owner: ownerId,
  title: "Riverside Cabin",
  location: "Bend",
  country: "United States",
  propertyType: "Cabin",
  price: 1500,
  bedrooms: 2,
  bathrooms: 1,
  maxGuests: 4,
  amenities: ["Wifi"],
  isActive: true,
};

function makeComparable(index, price) {
  return {
    _id: new mongoose.Types.ObjectId(),
    title: `Cabin ${index}`,
    location: "Bend",
    country: "United States",
    propertyType: "Cabin",
    price,
    bedrooms: 2,
    maxGuests: 4,
    amenities: ["Wifi"],
  };
}

function makeService({ aggregateRows, candidates = [], ownedListing = listing } = {}) {
  const calls = { listingQuery: null, pipeline: null, priceUpdate: null };
  const ListingModel = {
    findOne(query) {
      calls.listingQuery = query;
      return { select() { return this; }, lean: async () => ownedListing };
    },
    find(query) {
      calls.comparableQuery = query;
      return {
        select() { return this; },
        sort() { return this; },
        limit() { return this; },
        lean: async () => candidates,
      };
    },
    async updateOne(...args) {
      calls.priceUpdate = args;
      return { matchedCount: 1 };
    },
  };
  const BookingModel = {
    async aggregate(pipeline) {
      calls.pipeline = pipeline;
      return aggregateRows || [{
        totals: [{ total: 2, cancelled: 1 }],
        paid: [{
          confirmedBookingCount: 1,
          testPaymentBookingCount: 1,
          realPaidBookingCount: 0,
          subtotal: 0,
          paidNights: 0,
          averageStayNights: 2,
        }],
        trends: [{ _id: "2026-09-20", bookings: 1, testPaymentBookings: 1, realPaidBookings: 0, subtotal: 0 }],
        occupied: [{ count: 2 }],
        monthlyDemand: [],
      }];
    },
  };
  const ReviewModel = {
    async aggregate() {
      return [{ count: 2, averageRating: 4.5 }];
    },
  };
  return {
    calls,
    service: createHostAnalyticsService({ ListingModel, BookingModel, ReviewModel, now: () => now }),
  };
}

test("period validation only accepts supported bounded ranges", () => {
  assert.equal(validatePeriod("30"), 30);
  assert.equal(validatePeriod(365), 365);
  assert.throws(() => validatePeriod(60), HostAnalyticsError);
  assert.throws(() => validatePeriod("all"), HostAnalyticsError);
});

test("date range covers complete UTC days and excludes today", () => {
  const range = getDateRange(30, now);
  assert.equal(range.startKey, "2026-09-02");
  assert.equal(range.endKey, "2026-10-02");
  assert.equal(range.availableNights, 30);
});

test("comparable range requires three candidates and scopes to location and property type", () => {
  const candidates = [makeComparable(1, 1000), makeComparable(2, 1500), makeComparable(3, 2000)];
  const summary = summarizeComparables(listing, candidates);
  assert.equal(summary.count, 3);
  assert.equal(summary.scope, "same location, property type, and similar capacity");
  assert.deepEqual(summary.suggestedRange, { low: 1250, high: 1750 });
  const limited = summarizeComparables(listing, candidates.slice(0, 2));
  assert.equal(limited.suggestedRange, null);
  assert.match(limited.message, /not enough comparable/i);
});

test("demand baseline withholds estimates unless history spans enough months", () => {
  const insufficient = summarizeDemand([], now);
  assert.equal(insufficient.available, false);
  assert.equal(insufficient.estimate, null);
  const enoughMonths = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]
    .map((month) => ({ _id: month, count: 2 }));
  const demand = summarizeDemand(enoughMonths, now);
  assert.equal(demand.available, true);
  assert.equal(demand.estimate, 2);
  assert.equal(demand.direction, "stable");
});

test("neutral anomaly alerts require minimum evidence and avoid causal claims", () => {
  assert.deepEqual(analyzeAnomalies({
    confirmedBookingCount: 1,
    cancelledBookingCount: 1,
    occupancyRate: 20,
  }), []);
  const alerts = analyzeAnomalies({
    confirmedBookingCount: 2,
    cancelledBookingCount: 2,
    occupancyRate: 95,
  });
  assert.equal(alerts.length, 2);
  assert.match(alerts[0].message, /not an explanation of why/);
});

test("listing analytics are scoped to the authenticated owner and aggregate booking data", async () => {
  const candidates = [makeComparable(1, 1000), makeComparable(2, 1500), makeComparable(3, 2000)];
  const { service, calls } = makeService({ candidates });
  const analytics = await service.getListingAnalytics(ownerId, listingId.toString(), 30);
  assert.deepEqual(calls.listingQuery, { _id: listingId.toString(), owner: ownerId });
  assert.equal(analytics.performance.confirmedBookingCount, 1);
  assert.equal(analytics.performance.testPaymentBookingCount, 1);
  assert.equal(analytics.performance.realPaidBookingCount, 0);
  assert.equal(analytics.performance.paidAccommodationSubtotal, 0);
  assert.equal(analytics.performance.paidNights, 0);
  assert.equal(analytics.performance.occupancyRate, 6.7);
  assert.equal(analytics.reviews.averageRating, 4.5);
  assert.equal(analytics.trends.length, 30);
  assert.equal(analytics.comparables.suggestedRange.low, 1250);
  assert.equal(calls.pipeline[0].$match.listing, listingId);
  assert.equal(calls.pipeline[1].$facet.trends[1].$group._id.$dateToString.format, "%Y-%m-%d");
  assert.equal(calls.pipeline[1].$facet.monthlyDemand[0].$match.paymentProvider, "RAZORPAY");
  assert.deepEqual(
    calls.pipeline[1].$facet.paid[1].$group.subtotal.$sum.$cond[0],
    { $eq: ["$paymentProvider", "RAZORPAY"] }
  );
  assert.deepEqual(
    calls.pipeline[1].$facet.totals[1].$group.cancelled.$sum.$cond[0].$and[1],
    { $eq: ["$paymentStatus", "REFUNDED"] }
  );
});

test("a listing owned by somebody else is not available to analytics", async () => {
  const { service } = makeService({ ownedListing: null });
  await assert.rejects(
    () => service.getListingAnalytics(ownerId, listingId.toString(), 30),
    (error) => error instanceof HostAnalyticsError && error.status === 404
  );
});

test("price simulation is non-persistent and withholds low-sample revenue estimates", async () => {
  const { service, calls } = makeService();
  const result = await service.simulatePrice(ownerId, listingId.toString(), 30, "1750");
  assert.equal(result.simulatedPrice, 1750);
  assert.equal(result.persisted, false);
  assert.equal(result.revenueImpact, null);
  assert.match(result.revenueImpactMessage, /at least 10 RAZORPAY bookings/);
  assert.equal(calls.priceUpdate, null);
});

test("price application updates only the owned listing after explicit confirmation at route level", async () => {
  const { service, calls } = makeService();
  const result = await service.applyPrice(ownerId, listingId.toString(), 1800);
  assert.equal(result.price, 1800);
  assert.deepEqual(calls.priceUpdate[0], {
    _id: listingId.toString(),
    owner: ownerId,
    isActive: { $ne: false },
  });
  assert.deepEqual(calls.priceUpdate[1], { $set: { price: 1800 } });
});

test("host API rejects guest roles and permits host accounts", () => {
  function responseRecorder() {
    return {
      code: 200,
      body: null,
      status(code) { this.code = code; return this; },
      json(body) { this.body = body; return this; },
    };
  }
  const guestResponse = responseRecorder();
  requireHost({ user: { role: "user" } }, guestResponse, () => assert.fail("Guest access should be denied."));
  assert.equal(guestResponse.code, 403);
  const anonymousResponse = responseRecorder();
  requireHost({}, anonymousResponse, () => assert.fail("Anonymous access should be denied."));
  assert.equal(anonymousResponse.code, 401);
  const hostResponse = responseRecorder();
  let passed = false;
  requireHost({ user: { role: "host" } }, hostResponse, () => { passed = true; });
  assert.equal(passed, true);
});

test("applying a price requires an explicit confirmation flag", async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { _id: ownerId, role: "host" };
    next();
  });
  app.use("/api/analytics", router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/analytics/host/listings/${listingId}/apply-price`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ price: 2000 }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /confirm the price change/i);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("host intelligence EJS page renders with the shared layout and valid browser script", async () => {
  const app = express();
  app.engine("ejs", ejsMate);
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "..", "views"));
  app.use((req, res, next) => {
    res.locals.currentUser = { username: "host", name: "Host", role: "host", wishlist: [] };
    next();
  });
  app.get("/", (_req, res) => res.render("host/intelligence.ejs"));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Property intelligence/);
    assert.match(html, /Comparable asking prices/);
    assert.match(html, /Simulate a nightly price/);
    const scripts = html.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g) || [];
    for (const script of scripts) {
      const source = script.replace(/^<script(?:\s[^>]*)?>/, "").replace(/<\/script>$/, "");
      if (source.trim()) assert.doesNotThrow(() => new Function(source));
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("booking schema indexes support listing-scoped date range analytics", () => {
  const listingIndex = Booking.schema.indexes().find(([keys]) =>
    keys.listing === 1 && keys.checkIn === -1
  );
  assert.ok(listingIndex);
});

test("AI insight output can only select verified database-backed insight identifiers", async () => {
  let prompt = "";
  const service = createAnalyticsInsightsService({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl: async (_url, options) => {
      prompt = options.body;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ insights: ["booking_activity"] }) } }] }),
      };
    },
  });
  const result = await service.generate({
    listing: { title: "Riverside Cabin" },
    performance: {
      confirmedBookingCount: 2,
      testPaymentBookingCount: 0,
      realPaidBookingCount: 0,
      bookedNights: 4,
      availableNights: 30,
      occupancyRate: 13.3,
      cancelledBookingCount: 0,
    },
    reviews: { count: 0, averageRating: null },
    comparables: { count: 1, suggestedRange: null },
    demand: { available: false },
  });
  assert.deepEqual(result.insights, [{
    title: "Booking activity",
    text: "2 confirmed reservations were recorded, including 0 test-payment bookings.",
  }]);
  const requestBody = JSON.parse(prompt);
  assert.deepEqual(JSON.parse(requestBody.messages[1].content).allowedIds, ["booking_activity", "occupancy"]);
  const unsupported = createAnalyticsInsightsService({
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ insights: ["invented_revenue_claim"] }) } }] }),
    }),
  });
  await assert.rejects(() => unsupported.generate({
    listing: { title: "Riverside Cabin" },
    performance: { confirmedBookingCount: 1, realPaidBookingCount: 0, testPaymentBookingCount: 0, bookedNights: 0, cancelledBookingCount: 0 },
    reviews: { count: 0, averageRating: null },
    comparables: { count: 0, suggestedRange: null },
    demand: { available: false },
  }), HostAnalyticsError);
});
