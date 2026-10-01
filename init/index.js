require("dotenv").config();

const mongoose = require("mongoose");
const initData = require("./data.js");
const Listing = require("../models/listing.js");

const MONGODB_URI = process.env.MONGODB_URI;

async function main() {
  if (!MONGODB_URI) throw new Error("MONGODB_URI is not set in the environment.");
  await mongoose.connect(MONGODB_URI);
  console.log("connected to DB");

  await Listing.deleteMany({});
  await Listing.insertMany(initData.data);
  console.log("data was initialized");

  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error("database initialization failed:", err);
  await mongoose.connection.close();
  process.exitCode = 1;
});