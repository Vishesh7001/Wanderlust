const User = require("../models/user.js");

const attachUser = async (req, res, next) => {
  try {
    if (req.session.userId) {
      req.user = await User.findById(req.session.userId).select("_id username email");
    }
    res.locals.currentUser = req.user || null;
    next();
  } catch (err) {
    next(err);
  }
};

const requireLogin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "You must be logged in to do that." });
  }
  next();
};

const requirePageLogin = (req, res, next) => {
  if (!req.user) {
    const returnTo = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?next=${returnTo}`);
  }
  next();
};

module.exports = { attachUser, requireLogin, requirePageLogin };
