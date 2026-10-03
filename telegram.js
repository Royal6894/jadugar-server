import crypto from "node:crypto";

function timingSafeEqualHex(a, b) {
  const aa = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

/**
 * Validates Telegram Mini App initData using the bot token.
 * See Telegram Mini Apps docs for the initData validation procedure.
 */
export function validateTelegramInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData || !botToken) {
    throw new Error("Missing Telegram initData or bot token");
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date"));

  if (!receivedHash || !Number.isFinite(authDate)) {
    throw new Error("Invalid Telegram initData");
  }

  const age = Math.floor(Date.now() / 1000) - authDate;
  if (age < -60 || age > maxAgeSeconds) {
    throw new Error("Telegram initData expired");
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (!timingSafeEqualHex(calculatedHash, receivedHash)) {
    throw new Error("Invalid Telegram initData signature");
  }

  const userRaw = params.get("user");
  if (!userRaw) {
    throw new Error("Telegram user missing");
  }

  const user = JSON.parse(userRaw);
  if (!user?.id) {
    throw new Error("Telegram user ID missing");
  }

  return {
    telegramId: String(user.id),
    username: user.username ?? null,
    firstName: user.first_name ?? null,
    lastName: user.last_name ?? null,
    authDate
  };
}
