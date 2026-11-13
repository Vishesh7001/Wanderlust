const crypto = require("crypto");

/**
 * Determines whether demo payment mode is enabled.
 *
 * Evaluation rules:
 * 1. DEMO_PAYMENT_ENABLED (highest priority):
 *    - "true", "1", "yes" -> ENABLED (in any environment, including Render production)
 *    - "false", "0", "no" -> DISABLED
 * 2. PAYMENT_MODE:
 *    - "demo" -> ENABLED
 *    - "disabled" -> DISABLED
 * 3. Environment fallback:
 *    - In production (e.g. Render): If DEMO_PAYMENT_ENABLED is not explicitly set,
 *      demo payments remain strictly DISABLED for security.
 *    - In development (localhost): If DEMO_PAYMENT_ENABLED is not set, enabled unless PAYMENT_MODE === "disabled".
 */
function isDemoPaymentEnabled() {
  const demoFlag = String(process.env.DEMO_PAYMENT_ENABLED || "").trim().toLowerCase();
  if (["true", "1", "yes"].includes(demoFlag)) {
    return true;
  }
  if (["false", "0", "no"].includes(demoFlag)) {
    return false;
  }

  const paymentMode = String(process.env.PAYMENT_MODE || "").trim().toLowerCase();
  if (paymentMode === "demo") {
    return true;
  }
  if (paymentMode === "disabled") {
    return false;
  }

  // In production (Render), default to disabled if DEMO_PAYMENT_ENABLED is not explicitly configured
  if (process.env.NODE_ENV === "production") {
    return false;
  }

  // On localhost/dev, enabled by default when running in development
  return true;
}

const isMockPaymentEnabled = isDemoPaymentEnabled;

function createTestOrder(amountInPaise) {
  if (!isDemoPaymentEnabled()) {
    throw new Error("Demo checkout is disabled in production.");
  }
  return {
    id: `DEMO_RZP_${Date.now()}${crypto.randomInt(1000, 9999)}`,
    amount: amountInPaise,
    currency: "INR",
    label: "DEMO PAYMENT MODE",
    isDemo: true,
  };
}

function processTestPayment({ bookingId, orderId, expectedOrderId, expectedAmount, amount, outcome }) {
  if (!isDemoPaymentEnabled()) {
    return { verified: false, error: "Demo checkout is disabled in production." };
  }
  if (!/^(DEMO_RZP_|TEST_RZP_)\d+$/.test(orderId || "") || orderId !== expectedOrderId) {
    return { verified: false, error: "Test order does not match this booking." };
  }
  if (!Number.isInteger(amount) || amount !== expectedAmount) {
    return { verified: false, error: "Test payment amount does not match this booking." };
  }
  if (!["success", "failure", "cancel"].includes(outcome)) {
    return { verified: false, error: "Choose a valid test payment result." };
  }
  if (outcome !== "success") {
    return { verified: true, outcome, isDemo: true };
  }
  const suffix = crypto.randomBytes(4).toString("hex").toUpperCase();
  return {
    verified: true,
    outcome,
    paymentId: `DEMO_TXN_${suffix}`,
    bookingId: bookingId.toString(),
    amount,
    isDemo: true,
  };
}

module.exports = {
  createTestOrder,
  isMockPaymentEnabled,
  isDemoPaymentEnabled,
  processTestPayment,
};
