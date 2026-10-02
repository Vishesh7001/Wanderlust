const propertyTypes = ["Apartment", "House", "Cabin", "Villa", "Guesthouse", "Other"];

function buildFilters(params) {
  const query = { isActive: { $ne: false } };
  for (const field of ["location", "country", "title"]) {
    const value = String(params[field] || "").trim().slice(0, 100);
    if (value) query[field] = new RegExp(escapeRegex(value), "i");
  }

  const price = {};
  for (const [parameter, operator] of [["minPrice", "$gte"], ["maxPrice", "$lte"]]) {
    if (params[parameter] === undefined || params[parameter] === "") continue;
    const amount = Number(params[parameter]);
    if (!Number.isFinite(amount) || amount < 0 || amount > 10000000) return { error: `${parameter} must be a valid price.` };
    price[operator] = amount;
  }
  if (price.$gte !== undefined && price.$lte !== undefined && price.$gte > price.$lte) {
    return { error: "Minimum price cannot exceed maximum price." };
  }
  if (Object.keys(price).length) query.price = price;

  if (params.propertyType) {
    if (!propertyTypes.includes(params.propertyType)) return { error: "Choose a valid property type." };
    query.propertyType = params.propertyType;
  }

  for (const field of ["bedrooms", "bathrooms", "maxGuests"]) {
    if (params[field] === undefined || params[field] === "") continue;
    const count = Number(params[field]);
    if (!Number.isInteger(count) || count < 0 || count > 100) return { error: `${field} must be a whole number from 0 to 100.` };
    query[field] = { $gte: count };
  }

  const amenities = Array.isArray(params.amenities) ? params.amenities : String(params.amenities || "").split(",");
  const selectedAmenities = amenities.map((value) => String(value).trim().slice(0, 60)).filter(Boolean).slice(0, 20);
  if (selectedAmenities.length) {
    query.amenities = { $all: selectedAmenities.map((amenity) => new RegExp(escapeRegex(amenity), "i")) };
  }
  return { query };
}

function getListingInput(body, files = []) {
  const input = {};
  for (const field of ["title", "description", "location", "country"]) {
    if (body[field] !== undefined) input[field] = String(body[field]).trim();
  }
  if (body.price !== undefined) input.price = Number(body.price);
  if (body.propertyType !== undefined) input.propertyType = String(body.propertyType).trim();
  for (const field of ["bedrooms", "bathrooms", "maxGuests"]) {
    if (body[field] !== undefined) input[field] = Number(body[field]);
  }
  if (body.amenities !== undefined) {
    const amenities = Array.isArray(body.amenities) ? body.amenities : String(body.amenities).split(",");
    input.amenities = amenities.map((value) => String(value).trim()).filter(Boolean).slice(0, 30);
  }
  if (body.imageUrl !== undefined && String(body.imageUrl).trim()) {
    const url = String(body.imageUrl).trim();
    input.image = { url, filename: "" };
    input.images = [{ url, filename: "" }];
  }
  if (body.image !== undefined && typeof body.image === "string" && String(body.image).trim()) {
    const url = String(body.image).trim();
    input.image = { url, filename: "" };
    input.images = [{ url, filename: "" }];
  }
  if (body.image !== undefined && typeof body.image === "object" && body.image && body.image.url) {
    input.image = {
      url: String(body.image.url).trim(),
      filename: String(body.image.filename || "").trim(),
    };
    input.images = [input.image];
  }
  if (body.existingImages !== undefined) {
    const existingImages = Array.isArray(body.existingImages) ? body.existingImages : [body.existingImages];
    input.images = existingImages
      .map((value) => {
        if (typeof value === "object" && value !== null && value.url) return value;
        const str = String(value || "").trim();
        return str ? { url: str, filename: "" } : null;
      })
      .filter(Boolean)
      .slice(0, 8);
    input.image = input.images[0] || null;
  }
  if (files && files.length) {
    input.images = files.map((file) => {
      const url = file.path && /^https?:\/\//i.test(file.path)
        ? file.path
        : `/uploads/${file.filename}`;
      const filename = file.filename || "";
      return { url, filename };
    });
    input.image = input.images[0];
  }
  if (input.images && input.images.length && !input.image) {
    input.image = input.images[0];
  }
  if (input.image && (!input.images || !input.images.length)) {
    input.images = [input.image];
  }
  return input;
}

function getListingImageUrl(listing) {
  if (!listing) return "https://images.unsplash.com/photo-1507525428034-b723cf961d3e";
  const img = (listing.images && listing.images.length) ? listing.images[0] : listing.image;
  if (!img) return "https://images.unsplash.com/photo-1507525428034-b723cf961d3e";
  if (typeof img === "string" && img.trim()) return img.trim();
  if (typeof img === "object" && img.url) return img.url;
  return "https://images.unsplash.com/photo-1507525428034-b723cf961d3e";
}

function validationMessage(error) {
  return Object.values(error.errors).map((item) => item.message).join(" ");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { buildFilters, getListingInput, getListingImageUrl, validationMessage };