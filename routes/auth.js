const express = require("express");
const bcrypt = require("bcryptjs");
const User = require("../models/user.js");

const router = express.Router();

router.get("/me", (req, res) => {
  if (!req.user) {
    return res.json({ user: null });
  }
  res.json({ user: publicUser(req.user) });
});

router.post(["/register", "/signup"], async (req, res) => {
  try {
    const name = String(req.body.name || req.body.username || "").trim();
    const username = String(req.body.username || name).trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (name.length < 2 || name.length > 80 || username.length < 2 || username.length > 40 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      return res.status(400).json({ error: "Enter a valid name and email, and use a password with at least 8 characters including a number." });
    }

    const existingUser = await User.findOne({ $or: [{ username }, { email }] });
    if (existingUser) {
      return res.status(409).json({ error: existingUser.email === email ? "That email is already registered." : "That username is already taken." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ username, name, email, passwordHash });
    await regenerateSession(req, user._id);
    res.status(201).json({ message: "Account created successfully.", user: publicUser(user) });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "An account already uses that email or username." });
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

    await regenerateSession(req, user._id);
    res.json({ user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: "Unable to log in." });
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: "Unable to log out." });
    }
    // Clear the session cookie — must match the name set in session config.
    res.clearCookie("wl.sid", { path: "/", httpOnly: true, sameSite: "lax" });
    res.json({ success: true });
  });
});

function publicUser(user) {
  return {
    id: user._id,
    username: user.username,
    name: user.name || user.username,
    email: user.email,
    profileImage: user.profileImage || "",
    role: user.role || "user",
  };
}

function regenerateSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);
      req.session.userId = userId.toString();
      req.session.save((saveError) => saveError ? reject(saveError) : resolve());
    });
  });
}

module.exports = router;
