const mongoose = require("mongoose");

const Schema = mongoose.Schema;

const reviewInsightsSchema = new Schema({
	version: { type: Number, required: true },
	sourceHash: { type: String, required: true },
	reviewCount: { type: Number, required: true, min: 0 },
	analyzedReviewCount: { type: Number, required: true, min: 0 },
	sentiment: {
		type: String,
		enum: ["mostly_positive", "mixed", "mostly_negative"],
		required: true,
	},
	positiveTopics: { type: [String], default: [] },
	negativeTopics: { type: [String], default: [] },
	summary: { type: String, required: true, maxlength: 1200 },
	generatedAt: { type: Date, required: true },
}, { _id: false });

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
		type: Schema.Types.Mixed,
		default: {
			url: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e",
			filename: "listingimage",
		},
		set: (value) => {
			if (!value) {
				return {
					url: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e",
					filename: "listingimage",
				};
			}
			if (typeof value === "string") {
				const trimmed = value.trim();
				return trimmed ? { url: trimmed, filename: "" } : {
					url: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e",
					filename: "listingimage",
				};
			}
			return value;
		},
	},
	images: { type: [Schema.Types.Mixed], default: [] },
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
	reviewInsights: { type: reviewInsightsSchema, default: undefined },
}, { timestamps: true });

const Listing = mongoose.model("Listing", listingSchema);
module.exports = Listing;