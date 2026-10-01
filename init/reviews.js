require("dotenv").config();

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const Listing = require("../models/listing.js");
const User = require("../models/user.js");
const Review = require("../models/review.js");

const MONGODB_URI = process.env.MONGODB_URI;
const sampleReviews = [
  ["Rahul Sharma", "rahul@example.com", 5, "Amazing place with a beautiful view. Everything was clean, comfortable, and thoughtfully arranged."],
  ["Priya Singh", "priya@example.com", 4, "A peaceful stay in a lovely location. The host was helpful and check-in was very easy."],
  ["Arjun Mehta", "arjun@example.com", 5, "The photos do not do this place justice. We had a wonderful weekend and would happily return."],
  ["Ananya Roy", "ananya@example.com", 4, "Beautiful surroundings and a cozy room. The only small issue was slow Wi-Fi in the evening."],
  ["Rohan Das", "rohan@example.com", 3, "A pleasant stay overall, though the property was a little smaller than I expected from the pictures."],
  ["Neha Verma", "neha@example.com", 5, "Perfect for a quiet escape. The view at sunrise was unforgettable and the bed was incredibly comfortable."]
];

async function seedReviews() {
  if (!MONGODB_URI) throw new Error("MONGODB_URI is not set in the environment.");
  await mongoose.connect(MONGODB_URI);
  const listing = await Listing.findOne();
  if (!listing) throw new Error("Create listings before seeding reviews.");

  await Review.deleteMany({ listing: listing._id });
  const passwordHash = await bcrypt.hash("sample-review-user", 12);
  const reviews = [];

  for (const [username, email, rating, comment] of sampleReviews) {
    const user = await User.findOneAndUpdate(
      { username },
      { username, email, passwordHash },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    );
    reviews.push({ user: user._id, listing: listing._id, rating, comment });
  }

  await Review.insertMany(reviews);
  console.log(`Seeded ${reviews.length} reviews for ${listing.title}.`);
  await mongoose.connection.close();
}

seedReviews().catch(async (err) => {
  console.error("review seeding failed:", err);
  await mongoose.connection.close();
  process.exitCode = 1;
});
