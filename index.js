import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import { pool } from "./src/db/pool.js";
import { validateTelegramInitData } from "./telegram.js";

const app = express();
const PORT = Number(process.env.PORT || 4000);

app.use(express.json({ limit: "100kb" }));
app.use(cors({
  origin: process.env.CLIENT_ORIGIN?.split(",").map(s => s.trim()) || true
}));

const rewardAmount = BigInt(process.env.REWARD_AMOUNT || "50");
const cooldownSeconds = Number(process.env.REWARD_COOLDOWN_SECONDS || 60);
const initDataMaxAge = Number(process.env.TELEGRAM_INITDATA_MAX_AGE_SECONDS || 86400);

function getTelegramUser(req) {
  const initData = req.get("X-Telegram-Init-Data");
  return validateTelegramInitData(
    initData,
    process.env.TELEGRAM_BOT_TOKEN,
    initDataMaxAge
  );
}

async function upsertUser(tgUser) {
  const result = await pool.query(
    `
    INSERT INTO users (telegram_id, username, first_name, last_name)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (telegram_id)
    DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      updated_at = NOW()
    RETURNING id, telegram_id, username, first_name, last_name, balance
    `,
    [tgUser.telegramId, tgUser.username, tgUser.firstName, tgUser.lastName]
  );
  return result.rows[0];
}

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.get("/api/me", async (req, res) => {
  try {
    const tgUser = getTelegramUser(req);
    const user = await upsertUser(tgUser);
    res.json({
      user: {
        telegramId: user.telegram_id.toString(),
        username: user.username,
        firstName: user.first_name,
        lastName: user.last_name,
        balance: user.balance.toString()
      },
      reward: {
        amount: rewardAmount.toString(),
        cooldownSeconds
      }
    });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

/**
 * AdsGram Reward URL callback.
 *
 * Configure AdsGram with:
 * https://YOUR_API_DOMAIN/api/adsgram/reward?userid=[userId]
 *
 * The callback is the server-side signal used to issue LEAF.
 * We do NOT award points merely because the browser says the ad finished.
 */
app.get("/api/adsgram/reward", async (req, res) => {
  const telegramId = String(req.query.userid || "").trim();

  if (!/^\d{1,20}$/.test(telegramId)) {
    return res.status(400).json({ ok: false, error: "Invalid userid" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userResult = await client.query(
      `SELECT id, balance FROM users WHERE telegram_id = $1 FOR UPDATE`,
      [telegramId]
    );

    if (userResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const user = userResult.rows[0];

    const lastReward = await client.query(
      `
      SELECT created_at
      FROM transactions
      WHERE user_id = $1
        AND type = 'adsgram_reward'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [user.id]
    );

    if (lastReward.rowCount > 0) {
      const elapsed = (Date.now() - new Date(lastReward.rows[0].created_at).getTime()) / 1000;
      if (elapsed < cooldownSeconds) {
        await client.query("ROLLBACK");
        return res.status(429).json({
          ok: false,
          error: "Reward cooldown active"
        });
      }
    }

    const reference = `adsgram:${telegramId}:${crypto.randomUUID()}`;

    await client.query(
      `
      INSERT INTO transactions (user_id, type, amount, reference, metadata)
      VALUES ($1, 'adsgram_reward', $2, $3, $4)
      `,
      [
        user.id,
        rewardAmount.toString(),
        reference,
        JSON.stringify({ provider: "adsgram" })
      ]
    );

    const updated = await client.query(
      `
      UPDATE users
      SET balance = balance + $1, updated_at = NOW()
      WHERE id = $2
      RETURNING balance
      `,
      [rewardAmount.toString(), user.id]
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      telegramId,
      balance: updated.rows[0].balance.toString()
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    client.release();
  }
});

app.get("/api/transactions", async (req, res) => {
  try {
    const tgUser = getTelegramUser(req);

    const userResult = await pool.query(
      `SELECT id FROM users WHERE telegram_id = $1`,
      [tgUser.telegramId]
    );

    if (userResult.rowCount === 0) {
      return res.json({ transactions: [] });
    }

    const result = await pool.query(
      `
      SELECT type, amount, created_at
      FROM transactions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 50
      `,
      [userResult.rows[0].id]
    );

    res.json({
      transactions: result.rows.map(row => ({
        type: row.type,
        amount: row.amount.toString(),
        createdAt: row.created_at
      }))
    });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
