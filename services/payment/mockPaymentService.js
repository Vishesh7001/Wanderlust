const crypto = require("crypto");

function isMockPaymentEnabled() {
  return process.env.NODE_ENV !== "production" && process.env.PAYMENT_MODE !== "disabled";
}

function createTestOrder(amountInPaise) {
  if (!isMockPaymentEnabled()) throw new Error("Test payments are disabled in production.");
  return {
    id: `TEST_RZP_${Date.now()}${crypto.randomInt(1000, 9999)}`,
    amount: amountInPaise,
    currency: "INR",
    label: "TEST PAYMENT",
  };
}

function processTestPayment({ bookingId, orderId, expectedOrderId, expectedAmount, amount, outcome }) {
  if (!isMockPaymentEnabled()) return { verified: false, error: "Test payments are disabled in production." };
  if (!/^TEST_RZP_\d+$/.test(orderId || "") || orderId !== expectedOrderId) {
    return { verified: false, error: "Test order does not match this booking." };
  }
  if (!Number.isInteger(amount) || amount !== expectedAmount) {
    return { verified: false, error: "Test payment amount does not match this booking." };
  }
  if (!["success", "failure", "cancel"].includes(outcome)) {
    return { verified: false, error: "Choose a valid test payment result." };
  }
  if (outcome !== "success") return { verified: true, outcome };
  const suffix = crypto.randomBytes(4).toString("hex").toUpperCase();
  return {
    verified: true,
    outcome,
    paymentId: `TEST_TXN_${suffix}`,
    bookingId: bookingId.toString(),
    amount,
  };
}

module.exports = { createTestOrder, isMockPaymentEnabled, processTestPayment };