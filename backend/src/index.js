require("dotenv").config();

const express = require("express");
const db = require("./config/db");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.send("MediSync API is alive");
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "medisync" });
});

app.get("/api/health/db", async (req, res) => {
  try {
    const result = await db.query("SELECT NOW() AS now");
    res.json({ status: "ok", db_time: result.rows[0].now });
  } catch (err) {
    console.error("DB health check failed:", err.message);
    res.status(500).json({ status: "error", message: "database unreachable" });
  }
});

const authRoutes = require('./routes/auth.routes');
app.use('/api/auth', authRoutes);

const patientRoutes = require('./routes/patients.routes');
app.use('/api/patients', patientRoutes);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
