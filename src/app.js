import express from "express";
import cors from "cors";
import telemetryRoutes from "./routes/telemetry.routes.js";

const app = express();

app.use(express.json({ limit: "1mb" }));

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"],
  })
);

app.get("/", (req, res) => res.json({ ok: true, name: "Natsgo API" }));

app.use("/api", telemetryRoutes);

export default app;
