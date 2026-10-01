const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const mongoose = require("mongoose");
const Listing = require("../models/listing.js");
const { data: listings } = require("./data.js");

async function importListings() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set in the environment.");
  if (!Array.isArray(listings)) throw new Error("init/data.js must export a data array.");

  await mongoose.connect(uri);

  const operations = listings.map((listing) => ({
    updateOne: {
      filter: {
        title: listing.title,
        location: listing.location,
        country: listing.country,
      },
      update: { $setOnInsert: listing },
      upsert: true,
    },
  }));

  const result = await Listing.bulkWrite(operations, { ordered: false });
  const importedCount = result.upsertedCount;
  const skippedCount = listings.length - importedCount;
  const totalCount = await Listing.countDocuments();

  console.log(`Imported ${importedCount} new listings; skipped ${skippedCount} already present.`);
  console.log(`Listings collection now contains ${totalCount} records.`);
}

importListings()
  .catch((error) => {
    console.error("Listing import failed:", error.name, error.code || "");
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });