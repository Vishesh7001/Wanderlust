const express = require("express");
const bcrypt = require("bcryptjs");
const User = require("../models/user.js");

const router = express.Router();

router.get("/me", (req, res) => {
  if (!req.user) {
    return res.json({ user: null });
  }
  res.json({ user: { id: req.user._id, username: req.user.username, email: req.user.email } });
});

router.post(["/register", "/signup"], async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (username.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 6) {
      return res.status(400).json({ error: "Enter a valid email, a name, and a password of at least 6 characters." });
    }

    const existingUser = await User.findOne({ $or: [{ username }, { email }] });
    if (existingUser) {
      return res.status(409).json({ error: existingUser.email === email ? "That email is already registered." : "That username is already taken." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await User.create({ username, email, passwordHash });
    res.status(201).json({ message: "Account created successfully. Please login." });
  } catch (err) {
    res.status(500).json({ error: "Unable to create your account." });
  }
});

router.post("/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const user = await User.findOne({ email }).select("+passwordHash");

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    req.session.userId = user._id.toString();
    res.json({ user: { id: user._id, username: user.username, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: "Unable to log in." });
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: "Unable to log out." });
    }
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

module.exports = router;
