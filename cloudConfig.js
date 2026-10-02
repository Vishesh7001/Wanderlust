const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");

const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_KEY || process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_SECRET || process.env.CLOUDINARY_API_SECRET;

const isConfigured = Boolean(cloudName && apiKey && apiSecret);

if (isConfigured) {
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
} else {
  console.warn(
    "[cloudinary] CLOUDINARY_CLOUD_NAME, CLOUDINARY_KEY, and CLOUDINARY_SECRET environment variables are not fully set. " +
    "Cloud uploads will fall back to local disk storage until credentials are provided."
  );
}

let storage;
if (isConfigured) {
  storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
      folder: "wanderlust_DEV",
      allowed_formats: ["png", "jpg", "jpeg", "webp"],
      transformation: [{ quality: "auto", fetch_format: "auto" }],
    },
  });
} else {
  // Graceful fallback to disk storage when Cloudinary credentials are not yet configured
  const fs = require("fs");
  const path = require("path");
  const multer = require("multer");
  const uploadDirectory = path.join(__dirname, "public", "uploads");
  fs.mkdirSync(uploadDirectory, { recursive: true });

  storage = multer.diskStorage({
    destination: uploadDirectory,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      callback(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`);
    },
  });
}

async function deleteCloudinaryImage(publicId) {
  if (!publicId || !isConfigured) return;
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (error) {
    console.warn(`[cloudinary] Failed to delete image ${publicId}:`, error.message);
  }
}

module.exports = {
  cloudinary,
  storage,
  isCloudinaryConfigured: () => isConfigured,
  deleteCloudinaryImage,
};
