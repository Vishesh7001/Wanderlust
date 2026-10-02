require("dotenv").config();

const mongoose = require("mongoose");
const Listing = require("../models/listing.js");
const User = require("../models/user.js");
const Review = require("../models/review.js");

const MONGODB_URI = process.env.MONGODB_URI;
const reviewsByListingTitle = {
  "Cozy Beachfront Cottage": {
    rating: 5,
    comment: "I came for the ocean views and ended up spending most mornings on the beach just outside. The cottage was an easy, comfortable place to return to afterward.",
  },
  "Modern Loft in Downtown": {
    rating: 4,
    comment: "This was a practical base for a few busy days in New York City. Having a workspace and an elevator made the compact one-bedroom apartment much easier to manage.",
  },
  "Mountain Retreat": {
    rating: 5,
    comment: "After hiking nearby, we were glad to have a fireplace waiting at the cabin. It felt peaceful without being cut off from the trails we came to explore.",
  },
  "Historic Villa in Tuscany": {
    rating: 5,
    comment: "The restored villa has a character that newer places often miss. We especially enjoyed lingering in the garden and taking in the vineyard views.",
  },
  "Secluded Treehouse Getaway": {
    rating: 4,
    comment: "Sleeping among the trees made this Portland stay feel unlike an ordinary trip. I kept returning to the outdoor deck for a quiet break among the forest views.",
  },
  "Beachfront Paradise": {
    rating: 4,
    comment: "Being able to walk straight onto the sand was the highlight for us. The apartment also had a pool for the afternoons when we wanted a change of scene.",
  },
  "Rustic Cabin by the Lake": {
    rating: 3,
    comment: "We made good use of the kayaks and lake access during the day, then warmed up by the fireplace at night. The cabin suits travelers who plan to spend time outdoors.",
  },
  "Luxury Penthouse with City Views": {
    rating: 5,
    comment: "The wide city views made staying in Los Angeles feel special, and the gym and pool gave us plenty to do without leaving the building.",
  },
  "Ski-In/Ski-Out Chalet": {
    rating: 5,
    comment: "Starting the ski day right from the chalet was wonderfully convenient. We appreciated having dedicated ski storage and a hot tub to unwind in after the slopes.",
  },
  "Safari Lodge in the Serengeti": {
    rating: 5,
    comment: "The guided safari and wildlife views made this stay the centerpiece of our Tanzania trip. Breakfast before heading out was a welcome detail.",
  },
  "Historic Canal House": {
    rating: 4,
    comment: "Staying beside the canals gave our Amsterdam visit a strong sense of place. The house had the kitchen basics we wanted and enough room for our group.",
  },
  "Private Island Retreat": {
    rating: 5,
    comment: "The boat transfer is part of the adventure, and once we arrived the private pool and beach access made it easy to settle into island time.",
  },
  "Charming Cottage in the Cotswolds": {
    rating: 4,
    comment: "A proper countryside escape: we cooked in the kitchen, spent time in the garden, and were grateful for the fireplace when the evenings cooled down.",
  },
  "Historic Brownstone in Boston": {
    rating: 4,
    comment: "The brownstone's historic feel was a lovely contrast to our work trip. Its workspace and reliable WiFi made it comfortable to handle a few remote meetings.",
  },
  "Beachfront Bungalow in Bali": {
    rating: 5,
    comment: "We could hear the appeal of the beachfront location before we even unpacked. The private pool and air conditioning made it easy to relax between outings.",
  },
  "Mountain View Cabin in Banff": {
    rating: 5,
    comment: "The mountain scenery was the first thing we noticed each morning. After time on the hiking trails, the cabin's fireplace made a welcome place to rest.",
  },
  "Art Deco Apartment in Miami": {
    rating: 4,
    comment: "The Art Deco details gave the apartment its own personality, and beach access nearby was a bonus. The kitchen was handy for slower mornings.",
  },
  "Tropical Villa in Phuket": {
    rating: 5,
    comment: "We spent a surprising amount of our trip enjoying the infinity pool and then retreating to the air-conditioned villa. It was a restful home base in Phuket.",
  },
  "Historic Castle in Scotland": {
    rating: 4,
    comment: "Exploring the historic grounds felt like an experience in itself. The fireplace gave our group a natural place to gather after a day out in the Highlands.",
  },
  "Desert Oasis in Dubai": {
    rating: 5,
    comment: "The desert views gave the villa a calm atmosphere, while the private pool offered a refreshing counterpoint to the heat. The layout worked well for our group.",
  },
  "Rustic Log Cabin in Montana": {
    rating: 4,
    comment: "We used the barbecue for dinner and kept the fireplace going later in the evening. This cabin is a good match for a low-key stay surrounded by Montana scenery.",
  },
  "Beachfront Villa in Greece": {
    rating: 5,
    comment: "The sea views were even better in person, and we made the most of having both beach access and a pool. The kitchen also made a few meals at home simple.",
  },
  "Eco-Friendly Treehouse Retreat": {
    rating: 4,
    comment: "Knowing the treehouse runs on solar power suited the nature-focused trip we wanted. Forest views and nearby nature trails kept us happily occupied.",
  },
  "Historic Cottage in Charleston": {
    rating: 4,
    comment: "The restored cottage felt connected to Charleston's history, but the private garden was what made our evenings memorable. We found the kitchen and WiFi useful too.",
  },
  "Modern Apartment in Tokyo": {
    rating: 4,
    comment: "The central location and transit access made it simple to spend each day exploring Tokyo. We appreciated having a workspace to sort plans between outings.",
  },
  "Lakefront Cabin in New Hampshire": {
    rating: 5,
    comment: "Our favorite hours were out on the lake in the kayaks. Coming back to a warm fireplace afterward made this cabin especially enjoyable in the White Mountains.",
  },
  "Luxury Villa in the Maldives": {
    rating: 5,
    comment: "Waking up over the Indian Ocean was unforgettable. Breakfast and the private pool were thoughtful comforts that made it tempting to stay in all day.",
  },
  "Ski Chalet in Aspen": {
    rating: 4,
    comment: "The hot tub was a great end to our ski days, and the ski storage kept our gear organized. The chalet gave our group plenty of room to spread out.",
  },
  "Secluded Beach House in Costa Rica": {
    rating: 4,
    comment: "We spent the daylight hours surfing and came back to rinse off in the outdoor shower. The secluded Pacific coast setting was exactly the slower pace we wanted.",
  },
};

function normalizeComment(comment) {
  return comment.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function wordSimilarity(first, second) {
  const firstWords = new Set(normalizeComment(first).split(/\s+/));
  const secondWords = new Set(normalizeComment(second).split(/\s+/));
  const intersection = [...firstWords].filter((word) => secondWords.has(word)).length;
  return intersection / (firstWords.size + secondWords.size - intersection);
}

function assertUniqueReviewText(comments) {
  for (let firstIndex = 0; firstIndex < comments.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < comments.length; secondIndex += 1) {
      if (normalizeComment(comments[firstIndex]) === normalizeComment(comments[secondIndex])) {
        throw new Error("Duplicate review text found; refusing to insert reviews.");
      }
      if (wordSimilarity(comments[firstIndex], comments[secondIndex]) >= 0.6) {
        throw new Error("Near-duplicate review text found; refusing to insert reviews.");
      }
    }
  }
}

async function seedReviews() {
  if (!MONGODB_URI) throw new Error("MONGODB_URI is not set in the environment.");
  const applyChanges = process.argv.includes("--apply");

  await mongoose.connect(MONGODB_URI);
  const listings = await Listing.find({})
    .select("_id title description location country propertyType bedrooms bathrooms amenities")
    .lean();
  const existingReviews = await Review.find({})
    .select("_id listing user rating comment")
    .lean();
  const listingIds = new Set(listings.map((listing) => String(listing._id)));
  const userIds = new Set((await User.find({}).select("_id username").lean())
    .filter((user) => typeof user.username === "string" && user.username.trim())
    .map((user) => String(user._id)));

  const orphanReviews = existingReviews.filter((review) => !listingIds.has(String(review.listing)));
  if (orphanReviews.length) {
    throw new Error(`Found ${orphanReviews.length} reviews linked to missing listings; no data was changed.`);
  }

  const reviewsByListing = new Map();
  for (const review of existingReviews) {
    const listingId = String(review.listing);
    reviewsByListing.set(listingId, [...(reviewsByListing.get(listingId) || []), review]);
  }
  const listingsAlreadyReviewed = listings.filter((listing) => (reviewsByListing.get(String(listing._id)) || []).length);
  const listingsNeedingReviews = listings.filter((listing) => !(reviewsByListing.get(String(listing._id)) || []).length);
  const missingContent = listingsNeedingReviews.filter((listing) => !reviewsByListingTitle[listing.title]);
  if (missingContent.length) {
    throw new Error(`No listing-specific review content for: ${missingContent.map((listing) => listing.title).join(", ")}`);
  }

  const reviewerId = [...userIds][0];
  if (!reviewerId) {
    throw new Error("No existing user with a username is available; no user or review data was changed.");
  }

  const pendingReviews = await Promise.all(listingsNeedingReviews.map(async (listing) => {
    const content = reviewsByListingTitle[listing.title];
    const review = new Review({
      user: reviewerId,
      listing: listing._id,
      rating: content.rating,
      comment: content.comment,
    });
    await review.validate();
    return review;
  }));

  assertUniqueReviewText([
    ...existingReviews.map((review) => review.comment),
    ...pendingReviews.map((review) => review.comment),
  ]);

  const missingListingContent = listings.filter((listing) => !reviewsByListingTitle[listing.title]);
  if (missingListingContent.length) {
    throw new Error(`Listing review coverage is incomplete for: ${missingListingContent.map((listing) => listing.title).join(", ")}`);
  }

  console.log(`Database: ${mongoose.connection.name}; review collection: ${Review.collection.name}`);
  console.log(`Listings found: ${listings.length}; listings already reviewed: ${listingsAlreadyReviewed.length}`);
  console.log(`Listings receiving reviews: ${pendingReviews.length}; review documents to insert: ${pendingReviews.length}`);
  console.log(`Mode: ${applyChanges ? "apply (insert only)" : "dry run; pass --apply to save"}`);

  if (!applyChanges || !pendingReviews.length) return;

  const insertedReviews = await Review.insertMany(pendingReviews, { ordered: true });
  const insertedIds = insertedReviews.map((review) => review._id);
  const savedReviews = await Review.find({ _id: { $in: insertedIds } })
    .select("listing user rating comment")
    .lean();
  const savedUserIds = new Set((await User.find({ _id: { $in: savedReviews.map((review) => review.user) } })
    .select("_id username")
    .lean())
    .filter((user) => typeof user.username === "string" && user.username.trim())
    .map((user) => String(user._id)));
  const savedListingIds = new Set(listings.map((listing) => String(listing._id)));
  const expectedByListing = new Map(pendingReviews.map((review) => [
    String(review.listing),
    { rating: review.rating, comment: review.comment },
  ]));
  const invalidSavedReviews = savedReviews.filter((review) =>
    !savedListingIds.has(String(review.listing))
    || !savedUserIds.has(String(review.user))
    || expectedByListing.get(String(review.listing))?.rating !== review.rating
    || expectedByListing.get(String(review.listing))?.comment !== review.comment
  );

  if (savedReviews.length !== pendingReviews.length || invalidSavedReviews.length) {
    throw new Error("Post-insert verification failed: saved review count or listing/user references are invalid.");
  }

  console.log(`Verified ${savedReviews.length} reviews with existing listing and user references.`);
}

seedReviews()
  .catch((error) => {
    console.error("Review seeding failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });
