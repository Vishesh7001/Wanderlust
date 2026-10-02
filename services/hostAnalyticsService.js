const mongoose = require("mongoose");
const Listing = require("../models/listing.js");
const Booking = require("../models/booking.js");
const Review = require("../models/review.js");

const VALID_PERIODS = new Set([30, 90, 365]);
const OCCUPIED_STATUSES = ["CONFIRMED", "COMPLETED"];
const PAID_STATUSES = ["PAID", "SUCCESS"];
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_FORECAST_BOOKINGS = 12;
const MIN_COMPARABLES_FOR_RANGE = 3;
const MIN_BOOKINGS_FOR_REVENUE_SIMULATION = 10;

class HostAnalyticsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function validatePeriod(value) {
  const days = Number(value);
  if (!VALID_PERIODS.has(days)) {
    throw new HostAnalyticsError("Choose an analytics period of 30, 90, or 365 days.");
  }
  return days;
}

function getDateRange(days, now = new Date()) {
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - days * DAY_MS);
  return {
    start,
    end,
    startKey: start.toISOString().slice(0, 10),
    endKey: end.toISOString().slice(0, 10),
    availableNights: days,
  };
}

function roundCurrency(value) {
  return Math.round(Number(value) || 0);
}

function percentile(sortedValues, percentileValue) {
  if (!sortedValues.length) return null;
  const index = (sortedValues.length - 1) * percentileValue;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  if (lowerIndex === upperIndex) return sortedValues[lowerIndex];
  return sortedValues[lowerIndex] + (sortedValues[upperIndex] - sortedValues[lowerIndex]) * (index - lowerIndex);
}

function comparableScope(listing, candidates) {
  const samePlace = candidates.filter((candidate) =>
    candidate.location?.trim().toLocaleLowerCase() === listing.location?.trim().toLocaleLowerCase()
    && candidate.country?.trim().toLocaleLowerCase() === listing.country?.trim().toLocaleLowerCase()
  );
  const sameType = samePlace.filter((candidate) => candidate.propertyType === listing.propertyType);
  const similarCapacity = (candidate) =>
    Math.abs((candidate.bedrooms || 0) - (listing.bedrooms || 0)) <= 1
    && Math.abs((candidate.maxGuests || 0) - (listing.maxGuests || 0)) <= 2;
  const sameTypeCapacity = sameType.filter(similarCapacity);
  if (sameTypeCapacity.length >= MIN_COMPARABLES_FOR_RANGE) {
    return { candidates: sameTypeCapacity, scope: "same location, property type, and similar capacity" };
  }
  if (sameType.length >= MIN_COMPARABLES_FOR_RANGE) return { candidates: sameType, scope: "same location and property type" };
  if (samePlace.length >= MIN_COMPARABLES_FOR_RANGE) return { candidates: samePlace, scope: "same location" };

  const sameCountryType = candidates.filter((candidate) =>
    candidate.country?.trim().toLocaleLowerCase() === listing.country?.trim().toLocaleLowerCase()
    && candidate.propertyType === listing.propertyType
  );
  const sameCountryCapacity = sameCountryType.filter(similarCapacity);
  if (sameCountryCapacity.length >= MIN_COMPARABLES_FOR_RANGE) {
    return { candidates: sameCountryCapacity, scope: "same country, property type, and similar capacity" };
  }
  if (sameCountryType.length >= MIN_COMPARABLES_FOR_RANGE) {
    return { candidates: sameCountryType, scope: "same country and property type" };
  }
  if (sameCountryCapacity.length > 0) {
    return { candidates: sameCountryCapacity, scope: "same country and property type (limited sample)" };
  }
  if (sameCountryType.length > sameType.length) return { candidates: sameCountryType, scope: "same country and property type (limited sample)" };
  if (samePlace.length) return { candidates: samePlace, scope: "same location (limited sample)" };
  return { candidates: sameCountryType, scope: "same country and property type (limited sample)" };
}

function summarizeComparables(listing, candidates) {
  const { candidates: selected, scope } = comparableScope(listing, candidates);
  const prices = selected
    .map((candidate) => Number(candidate.price))
    .filter((price) => Number.isFinite(price) && price > 0)
    .sort((left, right) => left - right);
  const enoughData = prices.length >= MIN_COMPARABLES_FOR_RANGE;
  return {
    scope: prices.length ? scope : null,
    count: prices.length,
    properties: selected.slice(0, 8).map((candidate) => ({
      title: candidate.title,
      location: candidate.location,
      country: candidate.country,
      propertyType: candidate.propertyType,
      price: Number(candidate.price),
      bedrooms: candidate.bedrooms,
      maxGuests: candidate.maxGuests,
    })),
    minPrice: prices.length ? prices[0] : null,
    medianPrice: prices.length ? roundCurrency(percentile(prices, 0.5)) : null,
    maxPrice: prices.length ? prices[prices.length - 1] : null,
    suggestedRange: enoughData
      ? {
        low: roundCurrency(percentile(prices, 0.25)),
        high: roundCurrency(percentile(prices, 0.75)),
      }
      : null,
    message: enoughData
      ? null
      : "There are not enough comparable active listings to suggest a reliable price range.",
  };
}

function buildMonthlyBuckets(monthlyCounts, now = new Date()) {
  const lookup = new Map(monthlyCounts.map((row) => [row._id, row.count]));
  const currentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const previousMonths = [];
  for (let offset = 6; offset >= 1; offset -= 1) {
    const month = new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth() - offset, 1));
    const key = month.toISOString().slice(0, 7);
    previousMonths.push({ month: key, bookings: lookup.get(key) || 0 });
  }
  return previousMonths;
}

function summarizeDemand(monthlyCounts, now = new Date()) {
  const months = buildMonthlyBuckets(monthlyCounts, now);
  const totalBookings = months.reduce((total, month) => total + month.bookings, 0);
  const activeMonths = months.filter((month) => month.bookings > 0).length;
  if (totalBookings < MIN_FORECAST_BOOKINGS || activeMonths < 4) {
    return {
      available: false,
      estimate: null,
      direction: null,
      months,
      message: "Demand estimates need at least 12 RAZORPAY bookings spread across four of the last six complete months.",
    };
  }

  const previousAverage = months.slice(0, 3).reduce((total, month) => total + month.bookings, 0) / 3;
  const recentAverage = months.slice(3).reduce((total, month) => total + month.bookings, 0) / 3;
  const baseline = totalBookings / months.length;
  let direction = "stable";
  if (previousAverage > 0 && recentAverage > previousAverage * 1.2) direction = "increasing";
  else if (recentAverage < previousAverage * 0.8) direction = "decreasing";
  return {
    available: true,
    estimate: Math.round(baseline * 10) / 10,
    direction,
    months,
    message: "A simple baseline from six complete months of RAZORPAY bookings; this is not a guarantee.",
  };
}

function summarizeTrends(trends, days, range) {
  const buckets = [];
  if (days === 30) {
    const lookup = new Map(trends.map((row) => [row._id, row]));
    for (let day = range.start.getTime(); day < range.end.getTime(); day += DAY_MS) {
      const key = new Date(day).toISOString().slice(0, 10);
      const row = lookup.get(key);
      buckets.push({
        period: key,
        bookings: row?.bookings || 0,
        testPaymentBookings: row?.testPaymentBookings || 0,
        realPaidBookings: row?.realPaidBookings || 0,
        subtotal: roundCurrency(row?.subtotal || 0),
      });
    }
  } else {
    const lookup = new Map(trends.map((row) => [row._id, row]));
    const cursor = new Date(Date.UTC(range.start.getUTCFullYear(), range.start.getUTCMonth(), 1));
    const endMonth = new Date(Date.UTC(range.end.getUTCFullYear(), range.end.getUTCMonth(), 1));
    while (cursor <= endMonth) {
      const key = cursor.toISOString().slice(0, 7);
      const row = lookup.get(key);
      buckets.push({
        period: key,
        bookings: row?.bookings || 0,
        testPaymentBookings: row?.testPaymentBookings || 0,
        realPaidBookings: row?.realPaidBookings || 0,
        subtotal: roundCurrency(row?.subtotal || 0),
      });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }
  return buckets;
}

function analyzeAnomalies({ confirmedBookingCount, cancelledBookingCount, occupancyRate }) {
  const completedAndCancelled = confirmedBookingCount + cancelledBookingCount;
  const alerts = [];
  if (completedAndCancelled >= 4 && cancelledBookingCount >= 2 && cancelledBookingCount / completedAndCancelled >= 0.5) {
    alerts.push({
      type: "cancellations",
      severity: "notice",
      message: `${cancelledBookingCount} of ${completedAndCancelled} bookings with check-in dates in this period were later refunded or cancelled. This is a descriptive signal, not an explanation of why.`,
    });
  }
  if (occupancyRate !== null && occupancyRate >= 90) {
    alerts.push({
      type: "occupancy",
      severity: "notice",
      message: `Recorded occupancy was ${occupancyRate}% of nights in this period. Check future availability if you intend to accept more stays.`,
    });
  }
  return alerts;
}

function makeAggregationPipeline({ listingId, range, days }) {
  const historyStart = new Date(Date.UTC(range.end.getUTCFullYear() - 1, range.end.getUTCMonth(), 1));
  return [
    {
      $match: {
        listing: listingId,
        checkIn: { $lt: range.end },
        checkOut: { $gt: historyStart < range.start ? historyStart : range.start },
      },
    },
    {
      $facet: {
        totals: [
          { $match: { checkIn: { $gte: range.start, $lt: range.end } } },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              cancelled: {
                $sum: {
                  $cond: [{
                    $and: [
                      { $eq: ["$bookingStatus", "CANCELLED"] },
                      { $eq: ["$paymentStatus", "REFUNDED"] },
                    ],
                  }, 1, 0],
                },
              },
            },
          },
        ],
        paid: [
          {
            $match: {
              checkIn: { $gte: range.start, $lt: range.end },
              bookingStatus: { $in: OCCUPIED_STATUSES },
              paymentStatus: { $in: PAID_STATUSES },
            },
          },
          {
            $group: {
              _id: null,
              confirmedBookingCount: { $sum: 1 },
              testPaymentBookingCount: { $sum: { $cond: [{ $eq: ["$paymentProvider", "DEMO"] }, 1, 0] } },
              realPaidBookingCount: { $sum: { $cond: [{ $eq: ["$paymentProvider", "RAZORPAY"] }, 1, 0] } },
              subtotal: {
                $sum: {
                  $cond: [{ $eq: ["$paymentProvider", "RAZORPAY"] }, "$subtotal", 0],
                },
              },
              paidNights: {
                $sum: {
                  $cond: [{ $eq: ["$paymentProvider", "RAZORPAY"] }, "$nights", 0],
                },
              },
              averageStayNights: { $avg: "$nights" },
            },
          },
        ],
        trends: [
          {
            $match: {
              checkIn: { $gte: range.start, $lt: range.end },
              bookingStatus: { $in: OCCUPIED_STATUSES },
              paymentStatus: { $in: PAID_STATUSES },
            },
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: days === 30 ? "%Y-%m-%d" : "%Y-%m",
                  date: "$checkIn",
                  timezone: "UTC",
                },
              },
              bookings: { $sum: 1 },
              testPaymentBookings: { $sum: { $cond: [{ $eq: ["$paymentProvider", "DEMO"] }, 1, 0] } },
              realPaidBookings: { $sum: { $cond: [{ $eq: ["$paymentProvider", "RAZORPAY"] }, 1, 0] } },
              subtotal: {
                $sum: {
                  $cond: [{ $eq: ["$paymentProvider", "RAZORPAY"] }, "$subtotal", 0],
                },
              },
            },
          },
          { $sort: { _id: 1 } },
        ],
        occupied: [
          {
            $match: {
              bookingStatus: { $in: OCCUPIED_STATUSES },
              paymentStatus: { $in: PAID_STATUSES },
            },
          },
          { $unwind: "$reservedNightKeys" },
          {
            $match: {
              reservedNightKeys: { $gte: range.startKey, $lt: range.endKey },
            },
          },
          { $group: { _id: null, keys: { $addToSet: "$reservedNightKeys" } } },
          { $project: { count: { $size: "$keys" } } },
        ],
        monthlyDemand: [
          {
            $match: {
              checkIn: { $gte: historyStart, $lt: range.end },
              bookingStatus: { $in: OCCUPIED_STATUSES },
              paymentStatus: { $in: PAID_STATUSES },
              paymentProvider: "RAZORPAY",
            },
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m",
                  date: "$checkIn",
                  timezone: "UTC",
                },
              },
              count: { $sum: 1 },
            },
          },
        ],
      },
    },
  ];
}

function createHostAnalyticsService({
  ListingModel = Listing,
  BookingModel = Booking,
  ReviewModel = Review,
  now = () => new Date(),
} = {}) {
  async function getHostListings(userId) {
    return ListingModel.find({ owner: userId, isActive: { $ne: false } })
      .select("title location country price propertyType")
      .sort({ title: 1 })
      .lean();
  }

  async function getListingAnalytics(userId, listingId, periodValue = 30) {
    if (!mongoose.isValidObjectId(listingId)) throw new HostAnalyticsError("Listing not found.", 404);
    const days = validatePeriod(periodValue);
    const listing = await ListingModel.findOne({ _id: listingId, owner: userId })
      .select("title description location country price propertyType bedrooms bathrooms maxGuests amenities isActive")
      .lean();
    if (!listing) throw new HostAnalyticsError("Listing not found.", 404);

    const currentTime = now();
    const range = getDateRange(days, currentTime);
    const [analyticsRows, reviewSummary, candidates] = await Promise.all([
      BookingModel.aggregate(makeAggregationPipeline({ listingId: listing._id, range, days })),
      ReviewModel.aggregate([
        { $match: { listing: listing._id } },
        { $group: { _id: null, count: { $sum: 1 }, averageRating: { $avg: "$rating" } } },
      ]),
      ListingModel.find({
        _id: { $ne: listing._id },
        isActive: { $ne: false },
        country: listing.country,
      })
        .select("title location country price propertyType bedrooms bathrooms maxGuests amenities")
        .limit(100)
        .lean(),
    ]);

    const result = analyticsRows[0] || {};
    const totals = result.totals?.[0] || { total: 0, cancelled: 0 };
    const paid = result.paid?.[0] || {
      confirmedBookingCount: 0,
      testPaymentBookingCount: 0,
      realPaidBookingCount: 0,
      subtotal: 0,
      paidNights: 0,
      averageStayNights: 0,
    };
    const bookedNights = result.occupied?.[0]?.count || 0;
    const occupancyRate = range.availableNights
      ? Math.round((bookedNights / range.availableNights) * 1000) / 10
      : null;
    const comparison = summarizeComparables(listing, candidates);
    const confirmedBookingCount = paid.confirmedBookingCount || 0;
    const realPaidBookingCount = paid.realPaidBookingCount || 0;
    const cancelledBookingCount = totals.cancelled || 0;
    const demand = summarizeDemand(result.monthlyDemand || [], currentTime);
    const rating = reviewSummary[0] || { count: 0, averageRating: null };

    return {
      listing: {
        id: listing._id.toString(),
        title: listing.title,
        location: listing.location,
        country: listing.country,
        propertyType: listing.propertyType,
        currentPrice: Number(listing.price),
      },
      period: {
        days,
        start: range.startKey,
        endExclusive: range.endKey,
      },
      performance: {
        totalBookings: totals.total || 0,
        confirmedBookingCount,
        testPaymentBookingCount: paid.testPaymentBookingCount || 0,
        realPaidBookingCount,
        cancelledBookingCount,
        bookedNights,
        availableNights: range.availableNights,
        occupancyRate,
        paidAccommodationSubtotal: roundCurrency(paid.subtotal),
        paidNights: paid.paidNights || 0,
        averageBookingSubtotal: realPaidBookingCount ? roundCurrency(paid.subtotal / realPaidBookingCount) : null,
        averageStayNights: confirmedBookingCount ? Math.round(paid.averageStayNights * 10) / 10 : null,
        cancellationRate: confirmedBookingCount + cancelledBookingCount
          ? Math.round((cancelledBookingCount / (confirmedBookingCount + cancelledBookingCount)) * 100)
          : null,
      },
      reviews: {
        count: rating.count || 0,
        averageRating: rating.averageRating === null ? null : Math.round(rating.averageRating * 10) / 10,
      },
      comparables: comparison,
      trends: summarizeTrends(result.trends || [], days, range),
      demand,
      anomalies: analyzeAnomalies({ confirmedBookingCount, cancelledBookingCount, occupancyRate }),
      notes: [
        "Financial subtotals and revenue simulations include only bookings recorded with the RAZORPAY provider, before taxes and fees; they are not host payouts or proof of funds received.",
        "Confirmed stays and occupancy include successful DEMO checkout bookings; the application labels these as test payments and no real money is charged.",
        "Occupancy counts unique nights from confirmed or completed stays and does not account for calendar blocks not stored in this application.",
        "Comparable prices are active listing asking prices, not completed transaction prices.",
      ],
    };
  }

  async function simulatePrice(userId, listingId, periodValue, priceValue) {
    const price = Number(priceValue);
    if (!Number.isFinite(price) || price < 1 || price > 10000000) {
      throw new HostAnalyticsError("Enter a nightly price between 1 and 10,000,000.");
    }
    const analytics = await getListingAnalytics(userId, listingId, periodValue);
    const paidNights = analytics.performance.paidNights;
    const sufficientlyObserved = analytics.performance.realPaidBookingCount >= MIN_BOOKINGS_FOR_REVENUE_SIMULATION;
    return {
      currentPrice: analytics.listing.currentPrice,
      simulatedPrice: price,
      nightlyDifference: roundCurrency(price - analytics.listing.currentPrice),
      percentageDifference: Math.round(((price - analytics.listing.currentPrice) / analytics.listing.currentPrice) * 1000) / 10,
      revenueImpact: sufficientlyObserved
        ? {
          basedOnPaidNights: Math.round(paidNights),
          currentAccommodationSubtotal: roundCurrency(analytics.listing.currentPrice * paidNights),
          simulatedAccommodationSubtotal: roundCurrency(price * paidNights),
          note: "Illustrates the same past booked nights at a different price; it does not predict demand or future revenue.",
        }
        : null,
      revenueImpactMessage: sufficientlyObserved
        ? null
        : `Revenue impact is unavailable until at least ${MIN_BOOKINGS_FOR_REVENUE_SIMULATION} RAZORPAY bookings are recorded for this listing.`,
      persisted: false,
    };
  }

  async function applyPrice(userId, listingId, priceValue) {
    const price = Number(priceValue);
    if (!Number.isFinite(price) || price < 1 || price > 10000000) {
      throw new HostAnalyticsError("Enter a nightly price between 1 and 10,000,000.");
    }
    const result = await ListingModel.updateOne(
      { _id: listingId, owner: userId, isActive: { $ne: false } },
      { $set: { price } },
      { runValidators: true }
    );
    if (result.matchedCount !== 1) throw new HostAnalyticsError("Listing not found.", 404);
    return { price, message: "The listing price was updated after your confirmation." };
  }

  return { applyPrice, getHostListings, getListingAnalytics, simulatePrice };
}

function createAnalyticsInsightsService({
  fetchImpl = fetch,
  apiKey = process.env.GROQ_API_KEY,
  model = process.env.GROQ_MODEL || "openai/gpt-oss-20b",
} = {}) {
  async function generate(analytics) {
    const candidates = [];
    if (analytics.performance.confirmedBookingCount > 0) candidates.push("booking_activity");
    if (analytics.performance.realPaidBookingCount > 0) candidates.push("real_revenue");
    if (analytics.comparables.suggestedRange) candidates.push("comparable_pricing");
    if (analytics.reviews.count > 0) candidates.push("guest_reviews");
    if (analytics.performance.bookedNights > 0) candidates.push("occupancy");
    if (analytics.performance.cancelledBookingCount > 0) candidates.push("cancellations");
    if (!candidates.length) {
      return {
        insights: [],
        message: "There is not enough recorded activity to generate evidence-backed insights.",
      };
    }
    if (!apiKey) throw new HostAnalyticsError("AI insights are unavailable because GROQ_API_KEY is not configured.", 503);

    let response;
    try {
      response = await fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 120,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `Select up to three relevant insight IDs from this exact allowlist: ${candidates.join(", ")}. Return only JSON in the shape {"insights":["id"]}. Do not write explanations, numbers, or claims. The server will render selected IDs from verified database metrics.`,
            },
            {
              role: "user",
              content: JSON.stringify({
                listing: analytics.listing.title,
                recordedMetrics: {
                  confirmedBookingCount: analytics.performance.confirmedBookingCount,
                  testPaymentBookingCount: analytics.performance.testPaymentBookingCount,
                  realPaidBookingCount: analytics.performance.realPaidBookingCount,
                  realAccommodationSubtotal: analytics.performance.paidAccommodationSubtotal,
                  guestReviewCount: analytics.reviews.count,
                  averageGuestRating: analytics.reviews.averageRating,
                  bookedNights: analytics.performance.bookedNights,
                  occupancyRate: analytics.performance.occupancyRate,
                  cancelledBookingCount: analytics.performance.cancelledBookingCount,
                  comparableCount: analytics.comparables.count,
                  comparableRange: analytics.comparables.suggestedRange,
                  demandAvailable: analytics.demand.available,
                },
                allowedIds: candidates,
              }),
            },
          ],
        }),
      });
    } catch (error) {
      throw new HostAnalyticsError("Unable to generate AI insights right now. Please try again.", 502);
    }
    if (!response.ok) {
      throw new HostAnalyticsError("The AI provider could not generate insights. Please try again later.", 502);
    }
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new HostAnalyticsError("The AI provider returned an invalid insight selection.", 502);
    }
    if (!Array.isArray(parsed.insights) || parsed.insights.some((id) => !candidates.includes(id))) {
      throw new HostAnalyticsError("The AI provider selected an unsupported insight.", 502);
    }

    const renderers = {
      booking_activity: () => ({
        title: "Booking activity",
        text: `${analytics.performance.confirmedBookingCount} confirmed reservation${analytics.performance.confirmedBookingCount === 1 ? "" : "s"} were recorded, including ${analytics.performance.testPaymentBookingCount} test-payment booking${analytics.performance.testPaymentBookingCount === 1 ? "" : "s"}.`,
      }),
      real_revenue: () => ({
        title: "Recorded payment subtotal",
        text: `${analytics.performance.realPaidBookingCount} RAZORPAY booking${analytics.performance.realPaidBookingCount === 1 ? "" : "s"} recorded ${roundCurrency(analytics.performance.paidAccommodationSubtotal)} in accommodation subtotal before fees.`,
      }),
      comparable_pricing: () => ({
        title: "Comparable asking prices",
        text: `${analytics.comparables.count} active comparable listings indicate a ${analytics.comparables.suggestedRange.low}–${analytics.comparables.suggestedRange.high} nightly asking-price range.`,
      }),
      guest_reviews: () => ({
        title: "Guest rating",
        text: `${analytics.reviews.count} existing review${analytics.reviews.count === 1 ? "" : "s"} average ${analytics.reviews.averageRating} out of 5.`,
      }),
      occupancy: () => ({
        title: "Recorded occupancy",
        text: `${analytics.performance.bookedNights} of ${analytics.performance.availableNights} nights were booked (${analytics.performance.occupancyRate}% recorded occupancy).`,
      }),
      cancellations: () => ({
        title: "Cancellations",
        text: `${analytics.performance.cancelledBookingCount} booking${analytics.performance.cancelledBookingCount === 1 ? "" : "s"} were marked cancelled in this period; the data does not indicate a cause.`,
      }),
    };
    return {
      insights: [...new Set(parsed.insights)].map((id) => renderers[id]()),
      message: null,
    };
  }

  return { generate };
}

module.exports = {
  HostAnalyticsError,
  analyzeAnomalies,
  buildMonthlyBuckets,
  createAnalyticsInsightsService,
  createHostAnalyticsService,
  getDateRange,
  summarizeComparables,
  summarizeDemand,
  validatePeriod,
};
