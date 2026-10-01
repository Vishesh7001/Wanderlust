const fs = require("fs");
const path = require("path");
const multer = require("multer");

const uploadDirectory = path.join(__dirname, "..", "public", "uploads");
fs.mkdirSync(uploadDirectory, { recursive: true });

const uploader = multer({
  storage: multer.diskStorage({
    destination: uploadDirectory,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      callback(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, callback) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (allowedTypes.includes(file.mimetype)) return callback(null, true);
    callback(new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname));
  },
});

const listingImageFields = uploader.fields([
  { name: "listing[images]", maxCount: 8 },
  { name: "images", maxCount: 8 },
]);

function listingImages(req, res, next) {
  listingImageFields(req, res, (error) => {
    if (error) return next(error);
    const uploadedFields = req.files || {};
    req.listingImages = [
      ...(uploadedFields["listing[images]"] || []),
      ...(uploadedFields.images || []),
    ];
    next();
  });
}

module.exports = {
  listingImages,
  profileImage: uploader.single("profileImage"),
};