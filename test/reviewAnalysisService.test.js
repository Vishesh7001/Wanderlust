const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ReviewInsightsError,
  createReviewAnalysisService,
} = require("../services/ai/reviewAnalysisService.js");

function makeReview(id, comment, rating = 4) {
  return { _id: id, rating, comment, createdAt: new Date("2026-01-01T00:00:00Z") };
}

function createHarness(initialReviews) {
  const state = {
    reviews: [...initialReviews],
    listing: { _id: "listing", reviewInsights: undefined },
    providerCalls: 0,
    updates: 0,
    lastRequest: null,
  };
  const ListingModel = {
    findById(id) {
      assert.equal(id, "listing");
      return { select: async () => state.listing };
    },
    async updateOne(_query, update) {
      state.updates += 1;
      state.listing.reviewInsights = update.$set.reviewInsights;
      return { matchedCount: 1 };
    },
  };
  const ReviewModel = {
    find() {
      return {
        select() { return this; },
        sort() { return this; },
        limit() { return this; },
        async lean() { return [...state.reviews]; },
      };
    },
    async countDocuments() {
      return state.reviews.length;
    },
  };
  const fetchImpl = async (_url, options) => {
    state.providerCalls += 1;
    state.lastRequest = JSON.parse(options.body);
    const submitted = JSON.parse(state.lastRequest.messages[1].content);
    return {
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                reviewSentiments: submitted.map((review) => ({
                  reviewId: review.reviewId,
                  sentiment: "positive",
                  quote: review.comment,
                })),
                positiveTopics: [
                  {
                    topic: "location",
                    evidence: [{ reviewId: "r1", quote: "location was beautiful" }],
                  },
                  {
                    topic: "cleanliness",
                    evidence: [{ reviewId: "r2", quote: "Rooms were clean" }],
                  },
                ],
                negativeTopics: [
                  {
                    topic: "wifi",
                    evidence: [{ reviewId: "r3", quote: "WiFi was slow" }],
                  },
                ],
              }),
            },
          }],
        };
      },
    };
  };
  return {
    state,
    service: createReviewAnalysisService({
      ListingModel,
      ReviewModel,
      fetchImpl,
      apiKey: "test-key",
      model: "test-model",
    }),
  };
}

const threeReviews = [
  makeReview("r1", "The location was beautiful and quiet."),
  makeReview("r2", "Rooms were clean and the host was helpful."),
  makeReview("r3", "Our stay was comfortable, although the WiFi was slow."),
];

test("does not call AI or persist analysis when there are too few reviews", async () => {
  const { service, state } = createHarness([threeReviews[0]]);

  const result = await service.getInsights("listing");

  assert.equal(result.available, false);
  assert.match(result.message, /Not enough reviews/);
  assert.equal(result.reviewCount, 1);
  assert.equal(state.providerCalls, 0);
  assert.equal(state.updates, 0);
});

test("duplicate comments do not count as independent evidence", async () => {
  const { service, state } = createHarness([
    makeReview("r1", "The location was beautiful."),
    makeReview("r2", "The location was beautiful."),
    makeReview("r3", "THE LOCATION WAS BEAUTIFUL!"),
  ]);

  const result = await service.getInsights("listing");

  assert.equal(result.available, false);
  assert.equal(result.analyzedReviewCount, 1);
  assert.equal(result.ignoredReviewCount, 2);
  assert.equal(state.providerCalls, 0);
});

test("summarizes source-backed topics, quotes, and sentiment, then reuses the cache", async () => {
  const { service, state } = createHarness(threeReviews);

  const first = await service.getInsights("listing");
  const second = await service.getInsights("listing");

  assert.equal(first.available, true);
  assert.equal(first.cached, false);
  assert.equal(first.sentiment, "mostly_positive");
  assert.deepEqual(first.positiveTopics, ["location", "cleanliness"]);
  assert.deepEqual(first.negativeTopics, ["wifi"]);
  assert.match(first.summary, /location was beautiful/);
  assert.equal(state.providerCalls, 1);
  assert.equal(state.updates, 1);
  assert.equal(second.cached, true);
});

test("refreshes cached insights when new reviews arrive", async () => {
  const { service, state } = createHarness(threeReviews);
  await service.getInsights("listing");
  state.reviews.push(makeReview("r4", "The neighborhood was peaceful."));

  const refreshed = await service.getInsights("listing");

  assert.equal(refreshed.cached, false);
  assert.equal(refreshed.reviewCount, 4);
  assert.equal(state.providerCalls, 2);
  assert.equal(state.updates, 2);
});

test("ignores malformed review data rather than sending it to AI", async () => {
  const { service, state } = createHarness([
    ...threeReviews.slice(0, 2),
    { _id: "bad", rating: 8, comment: "" },
  ]);

  const result = await service.getInsights("listing");

  assert.equal(result.available, false);
  assert.equal(result.analyzedReviewCount, 2);
  assert.equal(result.ignoredReviewCount, 1);
  assert.equal(state.providerCalls, 0);
});

test("rejects provider evidence that cannot be tied to source review text", async () => {
  const { service } = createHarness(threeReviews);
  service.getInsights = createReviewAnalysisServiceForHallucination();

  await assert.rejects(service.getInsights("listing"), (error) =>
    error instanceof ReviewInsightsError && /source-backed sentiment/.test(error.message)
  );
});

function createReviewAnalysisServiceForHallucination() {
  const { createReviewAnalysisService } = require("../services/ai/reviewAnalysisService.js");
  return createReviewAnalysisService({
    ListingModel: {
      findById: () => ({ select: async () => ({ _id: "listing" }) }),
      updateOne: async () => ({ matchedCount: 1 }),
    },
    ReviewModel: {
      find: () => ({
        select() { return this; },
        sort() { return this; },
        limit() { return this; },
        async lean() { return [...threeReviews]; },
      }),
      countDocuments: async () => threeReviews.length,
    },
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              reviewSentiments: threeReviews.map((review) => ({
                reviewId: review._id,
                sentiment: "positive",
                quote: "Guests loved the swimming pool.",
              })),
              positiveTopics: [],
              negativeTopics: [],
            }),
          },
        }],
      }),
    }),
  }).getInsights;
}
