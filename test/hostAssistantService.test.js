const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  HostAssistantError,
  analyzeListingQuality,
  createHostAssistantService,
  sanitizeListingDraft,
  validateGeneratedContent,
  validateImageAnalysis,
} = require("../services/ai/hostAssistantService.js");

const listing = {
  _id: "listing-1",
  owner: "host-1",
  title: "Goa Apartment",
  description: "An apartment in Goa for a relaxing stay with useful amenities.",
  location: "Goa",
  country: "India",
  propertyType: "Apartment",
  price: 3200,
  bedrooms: 2,
  bathrooms: 1,
  maxGuests: 4,
  amenities: ["Wifi", "Kitchen"],
  images: [],
  image: "https://images.example.com/goa.jpg",
};

function makeListingQuery(value) {
  return { lean: async () => value };
}

function makeService({ ownedListing = listing, fetchImpl, reviews = [], bookingCount = 0, uploadDirectory } = {}) {
  const calls = { ownerQuery: null, fetchCalls: 0, aggregatePipeline: null, bookingQuery: null };
  const ListingModel = {
    findOne(query) {
      calls.ownerQuery = query;
      return makeListingQuery(ownedListing);
    },
  };
  const ReviewModel = {
    async aggregate(pipeline) {
      calls.aggregatePipeline = pipeline;
      return reviews;
    },
    find(query) {
      assert.equal(String(query.listing), String(listing._id));
      return {
        select() { return this; },
        sort() { return this; },
        limit() { return this; },
        async lean() { return reviews; },
      };
    },
  };
  const BookingModel = {
    async countDocuments(query) {
      calls.bookingQuery = query;
      return bookingCount;
    },
  };
  const provider = fetchImpl || (async (_url, options) => {
    calls.fetchCalls += 1;
    const body = JSON.parse(options.body);
    const userMessage = body.messages[1].content;
    let content = {};
    if (body.messages[0].content.includes('"titles"')) {
      content = { titles: ["Goa Two-Bedroom Apartment", "Apartment Stay in Goa", "Goa Apartment with Wifi"] };
    } else if (body.messages[0].content.includes('"description"')) {
      content = { description: "Stay in this two-bedroom apartment in Goa, with Wifi and a kitchen for guest use." };
    } else if (body.messages[0].content.includes('"highlights"')) {
      content = { highlights: ["Two bedrooms in Goa", "Wifi is available", "A kitchen is included"] };
    } else if (body.messages[0].content.includes("host assistant")) {
      const hostRequest = JSON.parse(userMessage);
      content = {
        claims: [
          {
            type: "observation",
            text: "The listing includes two bedrooms, Wifi, and a kitchen.",
            evidence: ["listing.bedrooms", "listing.amenities.0", "listing.amenities.1"],
          },
          {
            type: "suggestion",
            text: "You could add more detail about how guests can use the kitchen.",
            evidence: ["listing.amenities.1", "listing.description"],
          },
        ],
      };
      assert.equal(hostRequest.listing.paidConfirmedOrCompletedBookingCount, 2);
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
  });
  return {
    calls,
    service: createHostAssistantService({
      ListingModel,
      ReviewModel,
      BookingModel,
      fetchImpl: provider,
      apiKey: "test-key",
      model: "test-model",
      visionModel: "test-vision-model",
      uploadDirectory,
    }),
  };
}

test("title, description, and highlight generation use owned listing facts only", async () => {
  const { calls, service } = makeService();
  const description = await service.generateListingContent("host-1", "listing-1", "description");
  const titles = await service.generateListingContent("host-1", "listing-1", "titles");
  const highlights = await service.generateListingContent("host-1", "listing-1", "highlights");

  assert.match(description.description, /Wifi and a kitchen/);
  assert.equal(titles.titles.length, 3);
  assert.equal(highlights.highlights.length, 3);
  assert.equal(calls.fetchCalls, 3);
  assert.equal(calls.ownerQuery.owner, "host-1");
});

test("host assistant includes actual listing, review, and aggregate booking context", async () => {
  const reviews = [{ rating: 4, comment: "Wifi was reliable and the kitchen was useful." }];
  const { calls, service } = makeService({ reviews, bookingCount: 2 });

  const result = await service.answerHostQuestion("host-1", "listing-1", "How can I improve this listing?");

  assert.match(result.answer, /two bedrooms/);
  assert.match(result.answer, /Suggestion:/);
  assert.equal(calls.ownerQuery.owner, "host-1");
  assert.deepEqual(calls.bookingQuery.bookingStatus.$in, ["CONFIRMED", "COMPLETED"]);
  assert.equal(calls.bookingQuery.paymentStatus.$in.includes("PAID"), true);
});

test("non-owners cannot fetch listing data or call the AI provider", async () => {
  const { calls, service } = makeService({ ownedListing: null });

  await assert.rejects(service.generateListingContent("other-host", "listing-1", "description"), (error) =>
    error instanceof HostAssistantError && error.status === 404
  );
  assert.equal(calls.ownerQuery.owner, "other-host");
  assert.equal(calls.fetchCalls, 0);
});

test("rejects host assistant claims when supplied evidence does not support the feature", async () => {
  const { service } = makeService({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              claims: [{
                type: "observation",
                text: "The listing includes a kitchen.",
                evidence: ["listing.title"],
              }],
            }),
          },
        }],
      }),
    }),
  });

  await assert.rejects(service.answerHostQuestion("host-1", "listing-1", "What amenities are listed?"), (error) =>
    error instanceof HostAssistantError && /matching listing evidence/.test(error.message)
  );
});

test("draft generation accepts only known fields and does not persist or trust arbitrary values", async () => {
  const draft = sanitizeListingDraft({
    title: "Draft stay",
    location: "Kolkata",
    country: "India",
    propertyType: "Apartment",
    amenities: ["Wifi", { $where: "malicious" }, "Kitchen"],
    owner: "attacker",
    reviewInsights: { summary: "fake" },
  });

  assert.equal(draft.title, "Draft stay");
  assert.deepEqual(draft.amenities, ["Wifi", "Kitchen"]);
  assert.equal(Object.hasOwn(draft, "owner"), false);
  assert.equal(Object.hasOwn(draft, "reviewInsights"), false);
});

test("rejects generated content that claims an amenity absent from stored facts", () => {
  assert.throws(
    () => validateGeneratedContent({ description: "Enjoy the swimming pool in this comfortable stay in Goa with Wifi and a kitchen." }, "description", listing),
    (error) => error instanceof HostAssistantError && /pool/.test(error.message)
  );
});

test("retries generated content once after an unsupported feature and keeps the fact check", async () => {
  let requestCount = 0;
  let retryPrompt = "";
  const { service } = makeService({
    fetchImpl: async (_url, options) => {
      requestCount += 1;
      const request = JSON.parse(options.body);
      if (requestCount === 2) retryPrompt = request.messages[0].content;
      const content = requestCount === 1
        ? { description: "Stay in this two-bedroom apartment in Goa with air conditioning and Wifi for guests." }
        : { description: "Stay in this two-bedroom apartment in Goa with Wifi and a kitchen for guest use." };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }),
      };
    },
  });

  const result = await service.generateDraftContent({
    title: "Goa Apartment",
    location: "Goa",
    country: "India",
    propertyType: "Apartment",
    bedrooms: 2,
    bathrooms: 1,
    maxGuests: 4,
    amenities: ["Wifi", "Kitchen"],
  }, "description");

  assert.equal(requestCount, 2);
  assert.match(retryPrompt, /previous draft was rejected.*air conditioning/i);
  assert.doesNotMatch(result.description, /air conditioning/i);
});

test("unsupported feature remains blocked after one corrective retry", async () => {
  let requestCount = 0;
  const { service } = makeService({
    fetchImpl: async () => {
      requestCount += 1;
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                description: "Stay in this two-bedroom apartment in Goa with air conditioning and Wifi for guests.",
              }),
            },
          }],
        }),
      };
    },
  });

  await assert.rejects(
    () => service.generateDraftContent({
      title: "Goa Apartment",
      location: "Goa",
      country: "India",
      propertyType: "Apartment",
      bedrooms: 2,
      bathrooms: 1,
      maxGuests: 4,
      amenities: ["Wifi"],
    }, "description"),
    (error) => error instanceof HostAssistantError
      && /repeatedly suggested unsupported features.*air conditioning/i.test(error.message)
  );
  assert.equal(requestCount, 2);
});

test("retries Groq JSON validation failures once before returning generated content", async () => {
  let requestCount = 0;
  const { service } = makeService({
    fetchImpl: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: { type: "invalid_request_error", code: "json_validate_failed" },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                description: "Stay in this two-bedroom apartment in Goa with Wifi and a kitchen for guest use.",
              }),
            },
          }],
        }),
      };
    },
  });

  const result = await service.generateDraftContent({
    title: "Goa Apartment",
    location: "Goa",
    country: "India",
    propertyType: "Apartment",
    bedrooms: 2,
    bathrooms: 1,
    maxGuests: 4,
    amenities: ["Wifi", "Kitchen"],
  }, "description");

  assert.equal(requestCount, 2);
  assert.match(result.description, /Wifi and a kitchen/);
});

test("explains persistent Groq JSON validation errors without leaking provider details", async () => {
  let requestCount = 0;
  const { service } = makeService({
    fetchImpl: async () => {
      requestCount += 1;
      return {
        ok: false,
        status: 400,
        json: async () => ({
          error: { type: "invalid_request_error", code: "json_validate_failed", message: "private provider details" },
        }),
      };
    },
  });

  await assert.rejects(
    () => service.generateDraftContent({
      title: "Goa Apartment",
      location: "Goa",
      country: "India",
      propertyType: "Apartment",
      bedrooms: 2,
      bathrooms: 1,
      maxGuests: 4,
      amenities: ["Wifi", "Kitchen"],
    }, "description"),
    (error) => error instanceof HostAssistantError
      && /could not format a safe structured response after retrying/i.test(error.message)
      && !error.message.includes("private provider details")
  );
  assert.equal(requestCount, 2);
});

test("rejects invented room counts and private-pool claims", () => {
  assert.throws(
    () => validateGeneratedContent({ description: "Enjoy this three-bedroom apartment in Goa with Wifi and a kitchen for guests." }, "description", listing),
    (error) => error instanceof HostAssistantError && /bedrooms/.test(error.message)
  );
  assert.throws(
    () => validateGeneratedContent({ description: "Enjoy this two-bedroom apartment in Goa with a private pool and kitchen for guests." }, "description", listing),
    (error) => error instanceof HostAssistantError && /private pool/.test(error.message)
  );
});

test("quality analysis is transparent, factual, and reports insufficient booking evidence", () => {
  const result = analyzeListingQuality({
    ...listing,
    description: "Short.",
    images: [],
  }, { reviewCount: 0, ratingAverage: null });

  assert.equal(result.information.find((item) => item.label === "Location").complete, true);
  assert.equal(result.photos.count, 1);
  assert.equal(result.reviews.complete, false);
  assert.match(result.suggestions.join(" "), /photos/);
});

test("quality endpoint counts only paid confirmed or completed stays for the owner listing", async () => {
  const { calls, service } = makeService({ reviews: [{ count: 3, average: 4.5 }], bookingCount: 0 });

  const result = await service.analyzeQuality("host-1", "listing-1");

  assert.equal(result.reviews.count, 3);
  assert.equal(result.reviews.ratingAverage, 4.5);
  assert.match(result.bookings.message, /cannot be assessed/);
  assert.equal(calls.bookingQuery.listing, listing._id);
  assert.deepEqual(calls.bookingQuery.bookingStatus.$in, ["CONFIRMED", "COMPLETED"]);
});

test("photo response allows only known categories and issues", () => {
  const result = validateImageAnalysis({
    photos: [
      { imageIndex: 0, categories: ["bedroom", "invalid"], issues: ["dark"] },
      { imageIndex: 1, categories: ["kitchen"], issues: [] },
    ],
  }, [{}, {}]);

  assert.deepEqual(result.photos[0].categories, ["bedroom"]);
  assert.deepEqual(result.coverage.find((item) => item.category === "kitchen"), { category: "kitchen", detected: true });
  assert.equal(result.suggestions.some((item) => item.includes("bathroom")), true);
});

test("photo analysis sends only verified uploaded file bytes to the configured vision model", async () => {
  const uploadDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wanderlust-host-ai-"));
  const uploadedFile = path.join(uploadDirectory, "photo.jpg");
  await fs.writeFile(uploadedFile, Buffer.from("local image bytes"));
  const ownedListing = { ...listing, images: ["/uploads/photo.jpg", "https://images.example.com/external.jpg"] };
  let sentModel;
  let sentContent;
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    sentModel = request.model;
    sentContent = request.messages[1].content;
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              photos: [{ imageIndex: 0, categories: ["bedroom"], issues: [] }],
            }),
          },
        }],
      }),
    };
  };
  try {
    const { service } = makeService({ ownedListing, fetchImpl, uploadDirectory });
    const result = await service.analyzePhotos("host-1", "listing-1");

    assert.equal(sentModel, "test-vision-model");
    assert.equal(sentContent.length, 2);
    assert.match(sentContent[1].image_url.url, /^data:image\/jpeg;base64,/);
    assert.equal(result.analyzedImageCount, 1);
    assert.equal(result.skippedImageCount, 1);
    assert.equal(result.photos[0].categories[0], "bedroom");
  } finally {
    await fs.rm(uploadDirectory, { recursive: true, force: true });
  }
});
