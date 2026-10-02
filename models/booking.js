const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  listing: { type: mongoose.Schema.Types.ObjectId, ref: "Listing", required: true },
  host: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
  checkIn: { type: Date, required: true },
  checkOut: { type: Date, required: true },
  guests: { type: Number, required: true, min: 1, max: 100 },
  nights: { type: Number, required: true, min: 1 },
  pricePerNight: { type: Number, required: true, min: 1 },
  subtotal: { type: Number, required: true, min: 1 },
  gstAmount: { type: Number, required: true, min: 0, default: 0 },
  cleaningFee: { type: Number, required: true, min: 0 },
  serviceFee: { type: Number, required: true, min: 0 },
  totalPrice: { type: Number, required: true, min: 1 },
  paymentProvider: { type: String, enum: ["DEMO", "RAZORPAY"], default: "DEMO", required: true },
  paymentStatus: {
    type: String,
    enum: ["PENDING", "PAID", "SUCCESS", "FAILED", "CANCELLED", "REFUNDED"],
    default: "PENDING",
    index: true,
  },
  bookingStatus: {
    type: String,
    enum: ["PENDING", "CONFIRMED", "CANCELLED", "COMPLETED"],
    default: "PENDING",
    index: true,
  },
  paymentOrderId: { type: String, unique: true, sparse: true },
  paymentId: { type: String, unique: true, sparse: true },
  paymentExpiresAt: { type: Date, default: null, index: true },
  reservedNightKeys: { type: [String], required: true, select: false },
  cancelledAt: { type: Date, default: null },
  cancellationRequestedAt: { type: Date, default: null, select: false },
}, { timestamps: true });

bookingSchema.index(
  { listing: 1, reservedNightKeys: 1 },
  {
    unique: true,
    partialFilterExpression: { bookingStatus: { $in: ["PENDING", "CONFIRMED"] } },
    name: "active_listing_night_unique",
  }
);
bookingSchema.index({ user: 1, checkIn: -1 });
bookingSchema.index({ listing: 1, checkIn: -1 });

module.exports = mongoose.model("Booking", bookingSchema);