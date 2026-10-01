require("dotenv").config();

const express = require("express");
const app = express();
const mongoose = require("mongoose");
const { MongoStore } = require("connect-mongo");
const crypto = require("crypto");
const Listing = require("./models/listing.js");
const User = require("./models/user.js");
const path = require("path");
const methodOverride = require("method-override");
const ejsMate = require("ejs-mate");
const session = require("express-session");
const authRoutes = require("./routes/auth.js");
const reviewRoutes = require("./routes/reviews.js");
const listingApiRoutes = require("./routes/listings.js");
const userApiRoutes = require("./routes/users.js");
const wishlistApiRoutes = require("./routes/wishlist.js");
const bookingApiRoutes = require("./routes/bookings.js");
const paymentApiRoutes = require("./routes/payments.js");
const hostBookingApiRoutes = require("./routes/hostBookings.js");
const Booking = require("./models/booking.js");
const { attachUser, requirePageLogin } = require("./middleware/auth.js");
const { listingImages } = require("./middleware/uploads.js");
const { buildFilters, getListingInput, validationMessage } = require("./utils/listingUtils.js");

const MONGODB_URI = process.env.MONGODB_URI;
const PORT = Number(process.env.PORT) || 8080;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride("_method"));
app.engine("ejs", ejsMate);
app.use(express.static(path.join(__dirname, "/public")));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MONGODB_URI ? MongoStore.create({
      mongoUrl: MONGODB_URI,
      collectionName: "sessions",
      ttl: 60 * 60 * 24 * 7,
      autoRemove: "native",
    }) : undefined,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);
app.use(attachUser);
app.use("/auth", authRoutes);
app.use("/", authRoutes);
app.use("/api/auth", authRoutes);
app.use("/api", reviewRoutes);
app.use("/api/listings", listingApiRoutes);
app.use("/api/users", userApiRoutes);
app.use("/api/wishlist", wishlistApiRoutes);
app.use("/api/bookings", bookingApiRoutes);
app.use("/api/payments", paymentApiRoutes);
app.use("/api/host/bookings", hostBookingApiRoutes);

app.get("/", (req, res) => {
  res.redirect("/listings");
});

app.get("/auth", (req, res) => {
  res.redirect(req.user ? "/listings" : "/login");
});

app.get("/login", (req, res) => {
  if (req.user) return res.redirect("/listings");
  res.render("login.ejs", { message: req.query.message || "", next: req.query.next || "" });
});

app.get("/signup", (req, res) => {
  if (req.user) return res.redirect("/listings");
  res.render("signup.ejs");
});

app.get("/profile", requirePageLogin, (req, res) => {
  res.render("users/profile.ejs");
});

app.get("/my-listings", requirePageLogin, async (req, res) => {
  const allListings = await Listing.find({ owner: req.user._id, isActive: { $ne: false } }).sort({ createdAt: -1 });
  res.render("listings/index.ejs", {
    allListings,
    showWelcome: false,
    filters: {},
    searchError: "",
    pageTitle: "My Listings",
    isMyListings: true,
    isWishlist: false,
  });
});

app.get("/wishlist", requirePageLogin, async (req, res) => {
  const savedIds = (req.user.wishlist || []).map((listing) => listing._id || listing);
  const allListings = await Listing.find({ _id: { $in: savedIds }, isActive: { $ne: false } }).sort({ createdAt: -1 });
  res.render("listings/index.ejs", {
    allListings,
    showWelcome: false,
    filters: {},
    searchError: "",
    pageTitle: "My Wishlist",
    isMyListings: false,
    isWishlist: true,
  });
});

app.get("/my-trips", requirePageLogin, async (req, res) => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  await Booking.updateMany(
    { user: req.user._id, bookingStatus: "CONFIRMED", checkOut: { $lte: today } },
    { $set: { bookingStatus: "COMPLETED" } }
  );
  const bookings = await Booking.find({ user: req.user._id })
    .populate("listing", "title location country image images isActive")
    .sort({ checkIn: 1 });
  res.render("bookings/trips.ejs", { bookings });
});

app.get("/host/bookings", requirePageLogin, async (req, res) => {
  const listings = await Listing.find({ owner: req.user._id }).select("_id");
  const bookings = await Booking.find({ listing: { $in: listings.map((listing) => listing._id) } })
    .populate("listing", "title location country image images isActive")
    .populate("user", "name username email")
    .sort({ checkIn: 1 });
  res.render("bookings/host.ejs", { bookings });
});

//Index Route
app.get("/listings", async (req, res) => {
  const filters = buildFilters(req.query);
  const allListings = filters.error ? [] : await Listing.find(filters.query).sort({ createdAt: -1 });
  res.status(filters.error ? 400 : 200).render("listings/index.ejs", {
    allListings,
    showWelcome: req.query.welcome === "1",
    filters: req.query,
    searchError: filters.error || "",
    pageTitle: "Find your next stay",
    isMyListings: false,
    isWishlist: false,
  });
});

//New Route
app.get("/listings/new", requirePageLogin, (req, res) => {
  res.render("listings/new.ejs", { formError: "" });
});

app.get("/bookings/new", requirePageLogin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.query.listing)) return res.redirect("/listings");
  const params = new URLSearchParams();
  for (const field of ["checkIn", "checkOut"]) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query[field] || ""))) params.set(field, req.query[field]);
  }
  res.redirect(`/listings/${req.query.listing}${params.size ? `?${params}` : ""}`);
});

app.get("/bookings/:id", requirePageLogin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).send("Booking not found.");
  const booking = await Booking.findById(req.params.id)
    .populate("listing", "title location country image images owner isActive")
    .populate("user", "name username")
    .populate("host", "name username");
  if (!booking) return res.status(404).send("Booking not found.");
  const isGuest = booking.user._id.toString() === req.user._id.toString();
  const isHost = booking.host && booking.host._id.toString() === req.user._id.toString();
  if (!isGuest && !isHost) return res.status(403).send("You cannot view this booking.");
  res.render("bookings/detail.ejs", { booking, isGuest });
});

//Show Route
app.get("/listings/:id", async (req, res) => {
  let { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(404).send("Listing not found.");
  const listing = await Listing.findOne({ _id: id, isActive: { $ne: false } });
  if (!listing) return res.status(404).send("Listing not found.");
  res.render("listings/show.ejs", {
    listing,
    mapboxToken: process.env.MAPBOX_TOKEN || "",
    isOwner: Boolean(req.user && listing.owner && listing.owner.toString() === req.user._id.toString()),
    selectedCheckIn: /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.checkIn || "")) ? req.query.checkIn : "",
    selectedCheckOut: /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.checkOut || "")) ? req.query.checkOut : "",
  });
});

//Create Route
app.post("/listings", requirePageLogin, listingImages, async (req, res) => {
  const newListing = new Listing({ ...getListingInput(req.body.listing || {}, req.listingImages), owner: req.user._id });
  try {
    await newListing.save();
    await User.updateOne({ _id: req.user._id, role: "user" }, { $set: { role: "host" } });
    res.redirect("/listings");
  } catch (error) {
    if (error.name === "ValidationError") {
      return res.status(400).render("listings/new.ejs", { formError: validationMessage(error) });
    }
    throw error;
  }
});

//Edit Route
app.get("/listings/:id/edit", requirePageLogin, async (req, res) => {
  let { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(404).send("Listing not found.");
  const listing = await Listing.findOne({ _id: id, isActive: { $ne: false } });
  if (!listing) return res.status(404).send("Listing not found.");
  if (!listing.owner || listing.owner.toString() !== req.user._id.toString()) {
    return res.status(403).send("You can only edit listings you own.");
  }
  res.render("listings/edit.ejs", { listing, formError: "" });
});

//Update Route
app.put("/listings/:id", requirePageLogin, listingImages, async (req, res) => {
  let { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(404).send("Listing not found.");
  const listing = await Listing.findOne({ _id: id, isActive: { $ne: false } });
  if (!listing) return res.status(404).send("Listing not found.");
  if (!listing.owner || listing.owner.toString() !== req.user._id.toString()) {
    return res.status(403).send("You can only edit listings you own.");
  }
  Object.assign(listing, getListingInput(req.body.listing || {}, req.listingImages));
  try {
    await listing.save();
  } catch (error) {
    if (error.name === "ValidationError") {
      return res.status(400).render("listings/edit.ejs", { listing, formError: validationMessage(error) });
    }
    throw error;
  }
  res.redirect(`/listings/${id}`);
});

//Delete Route
app.delete("/listings/:id", requirePageLogin, async (req, res) => {
  let { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(404).send("Listing not found.");
  const listing = await Listing.findOne({ _id: id, isActive: { $ne: false } });
  if (!listing) return res.status(404).send("Listing not found.");
  if (!listing.owner || listing.owner.toString() !== req.user._id.toString()) {
    return res.status(403).send("You can only delete listings you own.");
  }
  listing.isActive = false;
  await listing.save();
  await User.updateMany({ wishlist: listing._id }, { $pull: { wishlist: listing._id } });
  res.redirect("/listings");
});

// app.get("/testListing", async (req, res) => {
//   let sampleListing = new Listing({
//     title: "My New Villa",
//     description: "By the beach",
//     price: 1200,
//     location: "Calangute, Goa",
//     country: "India",
//   });

//   await sampleListing.save();
//   console.log("sample was saved");
//   res.send("successful testing");
// });

async function startServer() {
  try {
    if (!MONGODB_URI) throw new Error("MONGODB_URI is not set in the environment.");
    if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
      throw new Error("SESSION_SECRET must be set in production.");
    }
    await mongoose.connect(MONGODB_URI);
    console.log("connected to DB");

    app.listen(PORT, () => {
      console.log(`server is listening to port ${PORT}`);
    });
  } catch (err) {
    console.error("database connection failed:", err.message);
    process.exit(1);
  }
}

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const isUploadError = error.name === "MulterError";
  const status = isUploadError ? 400 : 500;
  const message = isUploadError
    ? error.code === "LIMIT_FILE_SIZE" ? "Each image must be 5 MB or smaller." : "Upload up to 8 JPG, PNG, WEBP, or GIF images."
    : "Something went wrong. Please try again.";
  if (req.originalUrl.startsWith("/api/")) return res.status(status).json({ error: message });
  res.status(status).send(message);
});

startServer();