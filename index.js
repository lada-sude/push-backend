const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(bodyParser.json());

let subscribers = []; // ⚠️ In-memory for now; resets on server restart

// Subscribe endpoint
app.post("/subscribe", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).send("No token provided");

  if (!subscribers.includes(token)) subscribers.push(token);
  res.send({ success: true, subscribers });
});

// Send notification endpoint
app.post("/notify", async (req, res) => {
  const { title, body } = req.body;
  if (!title || !body) return res.status(400).send("Missing title/body");

  const messages = subscribers.map((t) => ({
    to: t,
    sound: "default",
    title,
    body,
  }));

  const results = [];
  for (let msg of messages) {
    const r = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    });
    results.push(await r.json());
  }

  res.send({ success: true, results });
});
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", message: "Backend is alive!" });
});

// Subscriber count endpoint
app.get("/count", (req, res) => {
  res.send({ count: subscribers.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
