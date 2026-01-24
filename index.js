const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(bodyParser.json());

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
   SEND NOTIFICATION
=========================== */
app.post("/send-notification", async (req, res) => {
  const { title, body } = req.body;

  if (!title || !body) {
    return res.status(400).json({
      error: "title and body are required",
    });
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
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messages),
    });

    const data = await response.json();
    console.log("📤 Expo response:", data);

    res.json({
      success: true,
      sent: messages.length,
    });
  } catch (err) {
    console.error("❌ Push error:", err);
    res.status(500).json({
      error: "Failed to send notification",
    });
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
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
