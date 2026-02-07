const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const admin = require("firebase-admin");
// ✅ ESM-compatible fetch for node-fetch v3
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(cors());
app.use(bodyParser.json());

// 🔥 Firebase Admin
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});

const firestore = admin.firestore();

// 🔔 In-memory storage (resets on restart — OK for now)
const subscribers = new Set();

/* ===========================
   HEALTH CHECK
=========================== */
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "Backend is alive!",
  });
});

/* ===========================
   REGISTER PUSH TOKEN
=========================== */
app.post("/register-token", (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: "No token provided" });
  }

  subscribers.add(token);
  console.log("📲 Registered token:", token);

  res.json({
    success: true,
    totalTokens: subscribers.size,
  });
});

/* ===========================
   SEND NOTIFICATION TO ALL
=========================== */
app.post("/send-notification", async (req, res) => {
  const { title, body } = req.body;

  if (!title || !body) {
    return res.status(400).json({ error: "title and body are required" });
  }

  if (subscribers.size === 0) {
    return res.status(400).json({ error: "No subscribers registered" });
  }

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
    console.log("📤 Expo response:", data);

    res.json({ success: true, sent: messages.length, expoResponse: data });
  } catch (err) {
    console.error("❌ Push error:", err);
    res.status(500).json({ error: "Failed to send notification" });
  }
});

/* ===========================
   SEND NOTIFICATION TO SINGLE USER
=========================== */
app.post("/notify-user", async (req, res) => {
  const { token, title, body } = req.body;

  if (!token || !title || !body) {
    return res.status(400).json({ error: "token, title, and body are required" });
  }

  const message = {
    to: token,
    sound: "default",
    title,
    body,
  };

  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });

    const data = await response.json();
    console.log("📤 Expo single-user response:", data);

    res.json({ success: true, expoResponse: data });
  } catch (err) {
    console.error("❌ Single-user push error:", err);
    res.status(500).json({ error: "Failed to send notification" });
  }
});

/* ===========================
   NOTIFY ADMINS
=========================== */
app.post("/notify-admins", async (req, res) => {
  const { title, body } = req.body;

  if (!title || !body) {
    return res.status(400).json({ error: "title and body are required" });
  }

  try {
    const snapshot = await firestore
      .collection("users")
      .where("role", "==", "admin")
      .get();

    if (snapshot.empty) {
      return res.json({ success: true, message: "No admins found" });
    }

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

    if (messages.length === 0) {
      return res.json({ success: true, message: "No admin tokens available" });
    }

    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messages),
    });

    const result = await response.json();
    console.log("📤 Admin notification response:", result);

    res.json({ success: true, sent: messages.length });
  } catch (err) {
    console.error("❌ Admin notify error:", err);
    res.status(500).json({ error: "Failed to notify admins" });
  }
});

/* ===========================
   SUBSCRIBER COUNT
=========================== */
app.get("/count", (req, res) => {
  res.json({ count: subscribers.size });
});

/* ===========================
   START SERVER
=========================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
