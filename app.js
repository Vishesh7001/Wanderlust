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
const hostAnalyticsRoutes = require("./routes/hostAnalytics.js");
const aiRoutes = require("./routes/ai.js");
const Booking = require("./models/booking.js");
const { attachUser, requirePageLogin } = require("./middleware/auth.js");
const { listingImages } = require("./middleware/uploads.js");
const { deleteCloudinaryImage } = require("./cloudConfig.js");
const {
  buildFilters,
  getListingInput,
  validationMessage,
} = require("./utils/listingUtils.js");
const {
  createTravelSearchService,
  normalizeConversation,
  TravelSearchError,
} = require("./services/ai/travelSearchService.js");
const {
  createRecommendationService,
} = require("./services/recommendationService.js");

const MONGODB_URI = process.env.MONGODB_URI;
const PORT = Number(process.env.PORT) || 8080;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

if (IS_PRODUCTION && !process.env.SESSION_SECRET) {
  console.error(
    "[auth] FATAL: SESSION_SECRET env variable is not set. " +
    "All sessions will be invalidated on every restart. " +
    "Set SESSION_SECRET in your Render environment variables."
  );
}

const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const recommendationService = createRecommendationService();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

/*
 * Trust the first proxy (Render, Vercel, etc.) so that
 * req.secure works correctly behind HTTPS reverse proxies.
 * Without this, secure cookies are never sent on Render.
 */
app.set("trust proxy", 1);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride("_method"));
app.engine("ejs", ejsMate);
app.use(express.static(path.join(__dirname, "/public")));

/*
 * ============================================================
 * MONGODB CONNECTION
 * ============================================================
 *
 * Vercel uses serverless functions, so we reuse the same
 * MongoDB connection whenever the function stays warm.
 */

let dbConnectionPromise = null;

async function connectToDatabase() {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is not set in the environment.");
  }

  // Already connected
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  // Reuse an existing connection attempt
  if (!dbConnectionPromise) {
    dbConnectionPromise = mongoose
      .connect(MONGODB_URI)
      .then(() => {
        console.log("connected to DB");
        return mongoose.connection;
      })
      .catch((error) => {
        dbConnectionPromise = null;
        console.error("database connection failed:", error.message);
        throw error;
      });
  }

  return dbConnectionPromise;
}

/*
 * ============================================================
 * VERCEL DATABASE MIDDLEWARE
 * ============================================================
 *
 * On Vercel, connect to MongoDB before processing requests.
 */

if (process.env.VERCEL) {
  app.use(async (req, res, next) => {
    try {
      await connectToDatabase();
      next();
    } catch (error) {
      next(error);
    }
  });
}

/*
 * ============================================================
 * SESSION
 * ============================================================
 */

app.use(
  session({
    name: "wl.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,

    store: MONGODB_URI
      ? MongoStore.create({
          mongoUrl: MONGODB_URI,
          collectionName: "sessions",
          ttl: 60 * 60 * 24 * 7,
          autoRemove: "native",
          touchAfter: 24 * 3600,
        })
      : undefined,

    cookie: {
      httpOnly: true,
      /*
       * sameSite: "lax" works for same-origin navigation.
       * On Render (HTTPS), the cookie must be secure so browsers
       * store and send it. req.secure is reliable after trust proxy.
       */
      sameSite: "lax",
      secure: IS_PRODUCTION,
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
app.use("/api/analytics", hostAnalyticsRoutes.router);
app.use("/api/ai", aiRoutes);

const travelSearch = createTravelSearchService();

/*
 * ============================================================
 * HOME
 * ============================================================
 */

app.get("/", (req, res) => {
  res.redirect("/listings");
});

/*
 * ============================================================
 * AUTH
 * ============================================================
 */

app.get("/auth", (req, res) => {
  res.redirect(req.user ? "/listings" : "/login");
});

app.get("/login", (req, res) => {
  if (req.user) return res.redirect("/listings");

  res.render("login.ejs", {
    message: req.query.message || "",
    next: req.query.next || "",
  });
});

app.get("/signup", (req, res) => {
  if (req.user) return res.redirect("/listings");

  res.render("signup.ejs");
});

/*
 * ============================================================
 * PROFILE
 * ============================================================
 */

app.get("/profile", requirePageLogin, (req, res) => {
  res.render("users/profile.ejs");
});

/*
 * ============================================================
 * AI ASSISTANT
 * ============================================================
 */

app.get("/ai-assistant", (req, res) => {
  res.render("ai-assistant.ejs", {
    conversation: [],
    allListings: [],
    result: null,
    error: "",
    previousMessage: "",
  });
});

app.post("/ai-assistant", async (req, res) => {
  const message =
    typeof req.body.message === "string" ? req.body.message.trim() : "";

  let conversation = [];
  let result = null;
  let errorMessage = "";
  let status = 200;

  try {
    conversation = normalizeConversation(req.body.conversation);

    result = await travelSearch.search(message, conversation);

    conversation = [
      ...conversation,
      { role: "user", content: message },
      { role: "assistant", content: result.message },
    ].slice(-8);
  } catch (error) {
    status = error instanceof TravelSearchError ? error.status : 500;

    errorMessage =
      error instanceof TravelSearchError
        ? error.message
        : "Unable to search stays right now. Please try again.";
  }

  res.status(status).render("ai-assistant.ejs", {
    conversation,
    allListings: result?.listings || [],
    result,
    error: errorMessage,
    previousMessage: result ? "" : message,
  });
});

/*
 * ============================================================
 * MY LISTINGS
 * ============================================================
 */

app.get("/my-listings", requirePageLogin, async (req, res) => {
  const allListings = await Listing.find({
    owner: req.user._id,
    isActive: { $ne: false },
  }).sort({ createdAt: -1 });

  res.render("listings/index.ejs", {
    allListings,
    showWelcome: false,
    filters: {},
    searchError: "",
    pageTitle: "My Listings",
    isMyListings: true,
    isWishlist: false,
    showRecommendations: false,
    recommendations: null,
    recommendationError: "",
  });
});

/*
 * ============================================================
 * WISHLIST
 * ============================================================
 */

app.get("/wishlist", requirePageLogin, async (req, res) => {
  const savedIds = (req.user.wishlist || []).map(
    (listing) => listing._id || listing
  );

  const allListings = await Listing.find({
    _id: { $in: savedIds },
    isActive: { $ne: false },
  }).sort({ createdAt: -1 });

  res.render("listings/index.ejs", {
    allListings,
    showWelcome: false,
    filters: {},
    searchError: "",
    pageTitle: "My Wishlist",
    isMyListings: false,
    isWishlist: true,
    showRecommendations: false,
    recommendations: null,
    recommendationError: "",
  });
});

/*
 * ============================================================
 * MY TRIPS
 * ============================================================
 */

app.get("/my-trips", requirePageLogin, async (req, res) => {
  const today = new Date();

  today.setUTCHours(0, 0, 0, 0);

  await Booking.updateMany(
    {
      user: req.user._id,
      bookingStatus: "CONFIRMED",
      checkOut: { $lte: today },
    },
    {
      $set: { bookingStatus: "COMPLETED" },
    }
  );

  const bookings = await Booking.find({
    user: req.user._id,
  })
    .populate("listing", "title location country image images isActive")
    .sort({ checkIn: 1 });

  res.render("bookings/trips.ejs", {
    bookings,
  });
});

/*
 * ============================================================
 * HOST BOOKINGS
 * ============================================================
 */

app.get("/host/bookings", requirePageLogin, async (req, res) => {
  const listings = await Listing.find({
    owner: req.user._id,
  }).select("_id");

  const bookings = await Booking.find({
    listing: {
      $in: listings.map((listing) => listing._id),
    },
  })
    .populate("listing", "title location country image images isActive")
    .populate("user", "name username email")
    .sort({ checkIn: 1 });

  res.render("bookings/host.ejs", {
    bookings,
  });
});

/*
 * ============================================================
 * HOST INTELLIGENCE
 * ============================================================
 */

app.get("/host/intelligence", requirePageLogin, (req, res) => {
  if (!["host", "admin"].includes(req.user.role)) {
    return res
      .status(403)
      .send("Host access is required to view property intelligence.");
  }

  res.render("host/intelligence.ejs");
});

/*
 * ============================================================
 * LISTINGS INDEX
 * ============================================================
 */

app.get("/listings", async (req, res) => {
  const filters = buildFilters(req.query);

  const allListings = filters.error
    ? []
    : await Listing.find(filters.query).sort({ createdAt: -1 });

  const hasSearchFilters = [
    "location",
    "country",
    "title",
    "minPrice",
    "maxPrice",
    "propertyType",
    "bedrooms",
    "bathrooms",
    "amenities",
  ].some((field) => String(req.query[field] || "").trim());

  let recommendations = null;
  let recommendationError = "";

  if (!filters.error && !hasSearchFilters) {
    try {
      recommendations =
        await recommendationService.getRecommendations(
          req.user?._id,
          req.session?.recommendationSearches
        );
    } catch (error) {
      console.error(
        "[recommendations] Could not load recommendations.",
        {
          errorType: error.name || "unknown",
        }
      );

      recommendationError = "Recommendations are temporarily unavailable.";
    }
  }

  res
    .status(filters.error ? 400 : 200)
    .render("listings/index.ejs", {
      allListings,
      showWelcome: req.query.welcome === "1",
      filters: req.query,
      searchError: filters.error || "",
      pageTitle: "Find your next stay",
      isMyListings: false,
      isWishlist: false,
      showRecommendations: Boolean(
        recommendations || recommendationError
      ),
      recommendations,
      recommendationError,
    });
});

/*
 * ============================================================
 * NEW LISTING
 * ============================================================
 */

app.get("/listings/new", requirePageLogin, (req, res) => {
  res.render("listings/new.ejs", {
    formError: "",
  });
});

/*
 * ============================================================
 * NEW BOOKING
 * ============================================================
 */

app.get("/bookings/new", requirePageLogin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.query.listing)) {
    return res.redirect("/listings");
  }

  const params = new URLSearchParams();

  for (const field of ["checkIn", "checkOut"]) {
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(
        String(req.query[field] || "")
      )
    ) {
      params.set(field, req.query[field]);
    }
  }

  res.redirect(
    `/listings/${req.query.listing}${
      params.size ? `?${params}` : ""
    }`
  );
});

/*
 * ============================================================
 * BOOKING DETAILS
 * ============================================================
 */

app.get("/bookings/:id", requirePageLogin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).send("Booking not found.");
  }

  const booking = await Booking.findById(req.params.id)
    .populate(
      "listing",
      "title location country image images owner isActive"
    )
    .populate("user", "name username")
    .populate("host", "name username");

  if (!booking) {
    return res.status(404).send("Booking not found.");
  }

  const isGuest =
    booking.user._id.toString() === req.user._id.toString();

  const isHost =
    booking.host &&
    booking.host._id.toString() === req.user._id.toString();

  if (!isGuest && !isHost) {
    return res
      .status(403)
      .send("You cannot view this booking.");
  }

  res.render("bookings/detail.ejs", {
    booking,
    isGuest,
  });
});

/*
 * ============================================================
 * SHOW LISTING
 * ============================================================
 */

app.get("/listings/:id", async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(404).send("Listing not found.");
  }

  const listing = await Listing.findOne({
    _id: id,
    isActive: { $ne: false },
  });

  if (!listing) {
    return res.status(404).send("Listing not found.");
  }

  res.render("listings/show.ejs", {
    listing,
    mapboxToken: process.env.MAPBOX_TOKEN || "",
    isOwner: Boolean(
      req.user &&
        listing.owner &&
        listing.owner.toString() === req.user._id.toString()
    ),
    selectedCheckIn:
      /^\d{4}-\d{2}-\d{2}$/.test(
        String(req.query.checkIn || "")
      )
        ? req.query.checkIn
        : "",
    selectedCheckOut:
      /^\d{4}-\d{2}-\d{2}$/.test(
        String(req.query.checkOut || "")
      )
        ? req.query.checkOut
        : "",
  });
});

/*
 * ============================================================
 * CREATE LISTING
 * ============================================================
 */

app.post(
  "/listings",
  requirePageLogin,
  listingImages,
  async (req, res) => {
    const newListing = new Listing({
      ...getListingInput(
        req.body.listing || {},
        req.listingImages
      ),
      owner: req.user._id,
    });

    try {
      await newListing.save();

      await User.updateOne(
        {
          _id: req.user._id,
          role: "user",
        },
        {
          $set: { role: "host" },
        }
      );

      res.redirect("/listings");
    } catch (error) {
      if (error.name === "ValidationError") {
        return res
          .status(400)
          .render("listings/new.ejs", {
            formError: validationMessage(error),
          });
      }

      throw error;
    }
  }
);

/*
 * ============================================================
 * EDIT LISTING
 * ============================================================
 */

app.get(
  "/listings/:id/edit",
  requirePageLogin,
  async (req, res) => {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).send("Listing not found.");
    }

    const listing = await Listing.findOne({
      _id: id,
      isActive: { $ne: false },
    });

    if (!listing) {
      return res.status(404).send("Listing not found.");
    }

    if (
      !listing.owner ||
      listing.owner.toString() !== req.user._id.toString()
    ) {
      return res
        .status(403)
        .send("You can only edit listings you own.");
    }

    res.render("listings/edit.ejs", {
      listing,
      formError: "",
    });
  }
);

/*
 * ============================================================
 * UPDATE LISTING
 * ============================================================
 */

app.put(
  "/listings/:id",
  requirePageLogin,
  listingImages,
  async (req, res) => {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).send("Listing not found.");
    }

    const listing = await Listing.findOne({
      _id: id,
      isActive: { $ne: false },
    });

    if (!listing) {
      return res.status(404).send("Listing not found.");
    }

    if (
      !listing.owner ||
      listing.owner.toString() !== req.user._id.toString()
    ) {
      return res
        .status(403)
        .send("You can only edit listings you own.");
    }

    const fields = getListingInput(
      req.body.listing || {},
      req.listingImages
    );

    // If new images were uploaded, clean up old Cloudinary images
    if (req.listingImages && req.listingImages.length > 0) {
      if (listing.image && typeof listing.image === "object" && listing.image.filename) {
        deleteCloudinaryImage(listing.image.filename);
      }
      if (Array.isArray(listing.images)) {
        for (const img of listing.images) {
          if (img && typeof img === "object" && img.filename) {
            deleteCloudinaryImage(img.filename);
          }
        }
      }
    }

    Object.assign(listing, fields);

    try {
      await listing.save();
    } catch (error) {
      if (error.name === "ValidationError") {
        return res
          .status(400)
          .render("listings/edit.ejs", {
            listing,
            formError: validationMessage(error),
          });
      }

      throw error;
    }

    res.redirect(`/listings/${id}`);
  }
);

/*
 * ============================================================
 * DELETE LISTING
 * ============================================================
 */

app.delete(
  "/listings/:id",
  requirePageLogin,
  async (req, res) => {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).send("Listing not found.");
    }

    const listing = await Listing.findOne({
      _id: id,
      isActive: { $ne: false },
    });

    if (!listing) {
      return res.status(404).send("Listing not found.");
    }

    if (
      !listing.owner ||
      listing.owner.toString() !== req.user._id.toString()
    ) {
      return res
        .status(403)
        .send("You can only delete listings you own.");
    }

    listing.isActive = false;

    // Delete image from Cloudinary if filename is stored
    if (listing.image && typeof listing.image === "object" && listing.image.filename) {
      deleteCloudinaryImage(listing.image.filename);
    }
    if (Array.isArray(listing.images)) {
      for (const img of listing.images) {
        if (img && typeof img === "object" && img.filename) {
          deleteCloudinaryImage(img.filename);
        }
      }
    }

    await listing.save();

    await User.updateMany(
      {
        wishlist: listing._id,
      },
      {
        $pull: {
          wishlist: listing._id,
        },
      }
    );

    res.redirect("/listings");
  }
);

/*
 * ============================================================
 * ERROR HANDLER
 * ============================================================
 */

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  const isUploadError = error.name === "MulterError";

  const status = isUploadError ? 400 : 500;

  const message = isUploadError
    ? error.code === "LIMIT_FILE_SIZE"
      ? "Each image must be 5 MB or smaller."
      : "Upload up to 8 JPG, PNG, WEBP, or GIF images."
    : "Something went wrong. Please try again.";

  if (req.originalUrl.startsWith("/api/")) {
    return res.status(status).json({
      error: message,
    });
  }

  res.status(status).send(message);
});

/*
 * ============================================================
 * LOCAL SERVER
 * ============================================================
 *
 * IMPORTANT:
 * app.listen() is used ONLY locally.
 * Vercel directly uses the exported Express app.
 */

if (!process.env.VERCEL) {
  connectToDatabase()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`server is listening to port ${PORT}`);
      });
    })
    .catch((error) => {
      console.error(
        "database connection failed:",
        error.message
      );
    });
}

/*
 * ============================================================
 * EXPORT APP FOR VERCEL
 * ============================================================
 */

module.exports = app;