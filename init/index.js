const mongoose = require("mongoose");
const initData = require("./data.js");
const Listing = require("../models/listing.js");

const MONGO_URL = "mongodb://127.0.0.1:27017/wanderlust";

async function main() {
  await mongoose.connect(MONGO_URL);
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