const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const admin = require("firebase-admin");

// ✅ ESM-compatible fetch (node-fetch v3)
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

/* =========================
   FIREBASE ADMIN INIT
========================= */
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
  });
}

const firestore = admin.firestore();
const { Timestamp } = admin.firestore;
const ONE_YEAR_IN_MS = 365 * 24 * 60 * 60 * 1000;

/* =========================
   EXPRESS SETUP
========================= */
const app = express();
app.use(cors());
app.use(bodyParser.json());

// 🔔 In-memory cache + persistent storage for push tokens
const subscribers = new Set();
const PUSH_SUBSCRIBERS_COLLECTION = "push_subscribers";

function normalizeToken(rawToken) {
  return typeof rawToken === "string" ? rawToken.trim() : "";
}

function isExpoPushToken(token) {
  return (
    token.startsWith("ExpoPushToken[") || token.startsWith("ExponentPushToken[")
  );
}

function tokenToDocId(token) {
  return Buffer.from(token)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function getAllRegisteredTokens() {
  const tokens = new Set([...subscribers]);

  const snap = await firestore.collection(PUSH_SUBSCRIBERS_COLLECTION).get();
  snap.forEach((entry) => {
    const token = normalizeToken(entry.data()?.token);
    if (token && isExpoPushToken(token)) {
      tokens.add(token);
      subscribers.add(token);
    }
  });

  return tokens;
}

/* =========================
   HEALTH CHECK
========================= */
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Backend is alive 🚀" });
});

/* =========================
   REGISTER PUSH TOKEN
========================= */
app.post("/register-token", async (req, res) => {
  const token = normalizeToken(req.body?.token);
  if (!token) return res.status(400).json({ error: "No token provided" });
  if (!isExpoPushToken(token)) {
    return res.status(400).json({ error: "Invalid Expo push token format" });
  }

  subscribers.add(token);

  try {
    await firestore
      .collection(PUSH_SUBSCRIBERS_COLLECTION)
      .doc(tokenToDocId(token))
      .set(
        {
          token,
          updatedAt: Timestamp.now(),
        },
        { merge: true }
      );
  } catch (err) {
    console.error("❌ Failed to persist token:", err);
  }

  console.log("📲 Registered token:", token);
  res.json({ success: true, totalTokens: subscribers.size });
});

/* =========================
   SEND NOTIFICATION TO ALL
========================= */
app.post("/send-notification", async (req, res) => {
  const { title, body } = req.body;
  if (!title || !body)
    return res.status(400).json({ error: "title and body are required" });

  const registeredTokens = await getAllRegisteredTokens();
  if (registeredTokens.size === 0) {
    return res.status(400).json({
      error:
        "No subscribers registered. Open the app once to register push token.",
    });
  }

  const messages = [...registeredTokens].map((token) => ({
    to: token,
    sound: "default",
    title,
    body,
  }));

  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messages),
    });

    const data = await response.json();
    res.json({ success: true, sent: messages.length, expoResponse: data });
  } catch (err) {
    console.error("❌ Push error:", err);
    res.status(500).json({ error: "Failed to send notification" });
  }
});

/* =========================
   SEND NOTIFICATION TO USER
========================= */
app.post("/notify-user", async (req, res) => {
  const { token, title, body } = req.body;
  if (!token || !title || !body)
    return res.status(400).json({ error: "token, title, body required" });

  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: token,
        sound: "default",
        title,
        body,
      }),
    });

    const data = await response.json();
    res.json({ success: true, expoResponse: data });
  } catch (err) {
    console.error("❌ Single push error:", err);
    res.status(500).json({ error: "Failed to notify user" });
  }
});

/* =========================
   NOTIFY ADMINS
========================= */
app.post("/notify-admins", async (req, res) => {
  const { title, body } = req.body;
  if (!title || !body)
    return res.status(400).json({ error: "title and body required" });

  try {
    const snapshot = await firestore
      .collection("users")
      .where("role", "==", "admin")
      .get();

    if (snapshot.empty)
      return res.json({ success: true, message: "No admins found" });

    const messages = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      if (data.expoPushToken) {
        messages.push({
          to: data.expoPushToken,
          sound: "default",
          title,
          body,
        });
      }
    });

    if (messages.length === 0)
      return res.json({ success: true, message: "No admin tokens available" });

    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messages),
    });

    const result = await response.json();
    res.json({ success: true, sent: messages.length, expoResponse: result });
  } catch (err) {
    console.error("❌ Admin notify error:", err);
    res.status(500).json({ error: "Failed to notify admins" });
  }
});

/* =========================
   AUTO-EXPIRE SUBSCRIPTIONS
========================= */
async function checkExpirations() {
  try {
    const now = Timestamp.now();

    const snapshot = await firestore
      .collection("user_payments")
      .where("status", "==", "active")
      .get();

    for (const docSnap of snapshot.docs) {
      const data = docSnap.data();
      if (!data.userId) continue;

      if (data.activatedAt && typeof data.activatedAt.toMillis === "function") {
        const minimumExpiresAt = Timestamp.fromMillis(
          data.activatedAt.toMillis() + ONE_YEAR_IN_MS
        );

        if (!data.expiresAt || data.expiresAt.toMillis() < minimumExpiresAt.toMillis()) {
          await firestore
            .collection("user_payments")
            .doc(docSnap.id)
            .update({ expiresAt: minimumExpiresAt });

          await firestore
            .collection("users")
            .doc(data.userId)
            .set({ subscriptionExpiresAt: minimumExpiresAt }, { merge: true });

          data.expiresAt = minimumExpiresAt;
        }
      }

      if (!data.expiresAt) continue;

      if (data.expiresAt.toMillis() <= now.toMillis()) {
        // 1️⃣ mark payment expired
        await firestore
          .collection("user_payments")
          .doc(docSnap.id)
          .update({ status: "expired" });

        // 2️⃣ check if user still has active subscriptions
        const stillActive = await firestore
          .collection("user_payments")
          .where("userId", "==", data.userId)
          .where("status", "==", "active")
          .get();

        if (stillActive.empty) {
          await firestore.collection("users").doc(data.userId).update({
            role: "user",
          });
        }

        // 3️⃣ notify user (token from users collection)
        const userSnap = await firestore
          .collection("users")
          .doc(data.userId)
          .get();

        const userData = userSnap.exists ? userSnap.data() : null;

        if (userData?.expoPushToken) {
          await fetch("https://exp.host/--/api/v2/push/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              to: userData.expoPushToken,
              sound: "default",
              title: "Subscription Ended ⚠️",
              body:
                "Your subscription has expired. Renew to continue premium access.",
            }),
          });
        }

        console.log(`⏰ Expired subscription for ${data.userId}`);
      }
    }
  } catch (err) {
    console.error("❌ Expiration job failed:", err);
  }
}

// ⏱ run every minute
setInterval(checkExpirations, 60 * 1000);
// 🚀 run once on startup
checkExpirations();

/* =========================
   SUBSCRIBER COUNT
========================= */
app.get("/count", async (req, res) => {
  try {
    const registeredTokens = await getAllRegisteredTokens();
    res.json({ count: registeredTokens.size });
  } catch (err) {
    console.error("❌ Failed to count subscribers:", err);
    res.status(500).json({ error: "Failed to count subscribers" });
  }
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
