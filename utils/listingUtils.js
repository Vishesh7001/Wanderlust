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
    input.image = url;
    input.images = [url];
  }
  if (body.image !== undefined && typeof body.image === "string" && String(body.image).trim()) {
    const url = String(body.image).trim();
    input.image = url;
    input.images = [url];
  }
  if (body.existingImages !== undefined) {
    const existingImages = Array.isArray(body.existingImages) ? body.existingImages : [body.existingImages];
    input.images = existingImages.map((value) => String(value).trim()).filter((value) => value.startsWith("/uploads/") || /^https?:\/\//i.test(value)).slice(0, 8);
    input.image = input.images[0] || "";
  }
  if (files && files.length) {
    input.images = files.map((file) => `/uploads/${file.filename}`);
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

function validationMessage(error) {
  return Object.values(error.errors).map((item) => item.message).join(" ");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { buildFilters, getListingInput, validationMessage };