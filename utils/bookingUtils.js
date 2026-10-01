const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANING_FEE = 500;
const SERVICE_FEE = 700;
const PAYMENT_WINDOW_MS = 15 * 60 * 1000;

function parseDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return date;
}

function getStay(checkInValue, checkOutValue) {
  const checkIn = parseDateOnly(checkInValue);
  const checkOut = parseDateOnly(checkOutValue);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (!checkIn || !checkOut) return { error: "Choose valid check-in and check-out dates." };
  if (checkIn < today) return { error: "Check-in cannot be in the past." };
  if (checkOut <= checkIn) return { error: "Check-out must be after check-in." };
  const nights = (checkOut.getTime() - checkIn.getTime()) / DAY_MS;
  if (!Number.isInteger(nights) || nights > 90) return { error: "A stay must be between 1 and 90 nights." };
  return { checkIn, checkOut, nights, nightKeys: makeNightKeys(checkIn, checkOut) };
}

function makeNightKeys(checkIn, checkOut) {
  const keys = [];
  for (let night = checkIn.getTime(); night < checkOut.getTime(); night += DAY_MS) {
    keys.push(new Date(night).toISOString().slice(0, 10));
  }
  return keys;
}

function getGuestCount(value, maxGuests) {
  const guests = Number(value);
  const capacity = Number(maxGuests) || 2;
  if (!Number.isInteger(guests) || guests < 1 || guests > capacity) {
    return { error: `Choose between 1 and ${capacity} guests.` };
  }
  return { guests };
}

function calculatePrice(pricePerNight, nights) {
  const subtotal = Math.round(Number(pricePerNight) * nights);
  const gstAmount = Math.round(subtotal * 0.18);
  const cleaningFee = CLEANING_FEE;
  const serviceFee = SERVICE_FEE;
  return {
    pricePerNight: Number(pricePerNight),
    subtotal,
    gstAmount,
    cleaningFee,
    serviceFee,
    totalPrice: subtotal + gstAmount + cleaningFee + serviceFee,
  };
}

function getPaymentExpiresAt() {
  return new Date(Date.now() + PAYMENT_WINDOW_MS);
}

module.exports = { calculatePrice, getGuestCount, getPaymentExpiresAt, getStay, makeNightKeys, parseDateOnly };