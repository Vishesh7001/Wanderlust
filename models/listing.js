const mongoose = require("mongoose");

const Schema = mongoose.Schema;

const listingSchema = new Schema({
	title: {
		type: String,
		required: true,
		trim: true,
		minlength: 3,
		maxlength: 120,
	},
	description: { type: String, trim: true, maxlength: 4000 },
	image: {
		type: String,
		default: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e",
		set: (value) => value === "" ? "https://images.unsplash.com/photo-1507525428034-b723cf961d3e" : value,
	},
	images: { type: [String], default: [] },
	price: { type: Number, required: true, min: 1, max: 10000000 },
	location: { type: String, required: true, trim: true, maxlength: 120 },
	country: { type: String, required: true, trim: true, maxlength: 120 },
	propertyType: {
		type: String,
		enum: ["Apartment", "House", "Cabin", "Villa", "Guesthouse", "Other"],
		default: "Other",
	},
	bedrooms: { type: Number, min: 0, max: 100, default: 0 },
	bathrooms: { type: Number, min: 0, max: 100, default: 0 },
	maxGuests: { type: Number, min: 1, max: 100, default: 2 },
	amenities: { type: [String], default: [] },
	owner: { type: Schema.Types.ObjectId, ref: "User", index: true },
	isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true });

const Listing = mongoose.model("Listing", listingSchema);
module.exports = Listing;