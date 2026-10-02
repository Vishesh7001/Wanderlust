const express = require("express");
const User = require("../models/user.js");
const { requireLogin } = require("../middleware/auth.js");
const { profileImage } = require("../middleware/uploads.js");

const router = express.Router();

router.get("/me", requireLogin, (req, res) => {
  res.json({ user: serializeUser(req.user) });
});

router.put("/me", requireLogin, profileImage, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    if (name.length < 2 || name.length > 80 || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: "Enter a name between 2 and 80 characters and a valid email." });
    }

    const emailOwner = await User.findOne({ email, _id: { $ne: req.user._id } }).select("_id");
    if (emailOwner) return res.status(409).json({ error: "That email is already in use." });

    const user = await User.findById(req.user._id);
    user.name = name;
    user.email = email;
    if (req.file) {
      user.profileImage = (req.file.path && /^https?:\/\//i.test(req.file.path))
        ? req.file.path
        : `/uploads/${req.file.filename}`;
    }
    await user.save();
    res.json({ user: serializeUser(user), message: "Profile updated." });
  } catch (error) {
    if (error.name === "ValidationError") return res.status(400).json({ error: "Check the profile fields and try again." });
    if (error.code === 11000) return res.status(409).json({ error: "That email is already in use." });
    res.status(500).json({ error: "Unable to update your profile." });
  }
});

function serializeUser(user) {
  return {
    id: user._id,
    username: user.username,
    name: user.name || user.username,
    email: user.email,
    profileImage: user.profileImage || "",
    role: user.role || "user",
  };
}

module.exports = router;