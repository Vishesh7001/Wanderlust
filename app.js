const express = require("express");
const app = express();
const mongoose = require("mongoose");
const Listing = require("./models/listing.js");
const path = require("path");
const methodOverride = require("method-override");
const ejsMate = require("ejs-mate");
const session = require("express-session");
const authRoutes = require("./routes/auth.js");
const reviewRoutes = require("./routes/reviews.js");
const { attachUser, requirePageLogin } = require("./middleware/auth.js");

const MONGO_URL = "mongodb://127.0.0.1:27017/wanderlust";

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride("_method"));
app.engine("ejs", ejsMate);
app.use(express.static(path.join(__dirname, "/public")));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "wanderlust-development-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 24 * 7 },
  })
);
app.use(attachUser);
app.use("/auth", authRoutes);
app.use("/", authRoutes);
app.use("/api", reviewRoutes);

app.get("/", (req, res) => {
  res.redirect(req.user ? "/listings" : "/login");
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

//Index Route
app.get("/listings", requirePageLogin, async (req, res) => {
  const allListings = await Listing.find({});
  res.render("listings/index.ejs", { allListings });
});

//New Route
app.get("/listings/new", requirePageLogin, (req, res) => {
  res.render("listings/new.ejs");
});

//Show Route
app.get("/listings/:id", requirePageLogin, async (req, res) => {
  let { id } = req.params;
  const listing = await Listing.findById(id);
  res.render("listings/show.ejs", { listing });
});

//Create Route
app.post("/listings", requirePageLogin, async (req, res) => {
  const newListing = new Listing(req.body.listing);
  await newListing.save();
  res.redirect("/listings");
});

//Edit Route
app.get("/listings/:id/edit", requirePageLogin, async (req, res) => {
  let { id } = req.params;
  const listing = await Listing.findById(id);
  res.render("listings/edit.ejs", { listing });
});

//Update Route
app.put("/listings/:id", requirePageLogin, async (req, res) => {
  let { id } = req.params;
  await Listing.findByIdAndUpdate(id, { ...req.body.listing });
  res.redirect(`/listings/${id}`);
});

//Delete Route
app.delete("/listings/:id", requirePageLogin, async (req, res) => {
  let { id } = req.params;
  let deletedListing = await Listing.findByIdAndDelete(id);
  console.log(deletedListing);
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
    await mongoose.connect(MONGO_URL);
    console.log("connected to DB");

    app.listen(8080, () => {
      console.log("server is listening to port 8080");
    });
  } catch (err) {
    console.error("database connection failed:", err.message);
    process.exit(1);
  }
}

startServer();