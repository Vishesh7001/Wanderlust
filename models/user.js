const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 2,
    },
    name: {
      type: String,
      trim: true,
      minlength: 2,
      maxlength: 80,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    profileImage: {
      type: String,
      default: "",
      maxlength: 500,
    },
    role: {
      type: String,
      enum: ["user", "host", "admin"],
      default: "user",
    },
    wishlist: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: "Listing",
    }],
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
