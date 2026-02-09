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

/* =========================
   EXPRESS SETUP
========================= */
const app = express();
app.use(cors());
app.use(bodyParser.json());

// 🔔 In-memory push registry (OK for now)
const subscribers = new Set();

/* =========================
   HEALTH CHECK
========================= */
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Backend is alive 🚀" });
});

/* =========================
   REGISTER PUSH TOKEN
========================= */
app.post("/register-token", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "No token provided" });

  subscribers.add(token);
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

  if (subscribers.size === 0)
    return res.status(400).json({ error: "No subscribers registered" });

  const messages = [...subscribers].map((token) => ({
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
      if (!data.expiresAt || !data.userId) continue;

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
app.get("/count", (req, res) => {
  res.json({ count: subscribers.size });
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
