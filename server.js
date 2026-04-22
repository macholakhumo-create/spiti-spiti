import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import pool from "./db.js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// DESIGN LOGS: Polished console output
const log = (msg, color = '\x1b[36m') => console.log(`${color}[CORE] ${msg}\x1b[0m`);

io.on("connection", (socket) => {
  log(`Connection established: ${socket.id}`, '\x1b[32m');

  socket.on("join-role", ({ role, userId }) => {
    socket.join(role);
    if (role === "drivers") socket.join(`driver:${userId}`);
    if (role === "rider") socket.join(`rider:${userId}`);
    log(`Role Sync: ${role} | ID: ${userId} | Active Rooms: ${[...socket.rooms].length}`);
  });

  socket.on("join-ride", ({ rideId }) => {
    socket.join(`ride:${rideId}`);
    log(`Syncing Ride Stream: ${rideId}`);
  });

  socket.on("disconnect", () => {
    log(`Connection closed: ${socket.id}`, '\x1b[31m');
  });
});

// Helper to notify rider
function notifyRider(riderId, event, data) {
  if (riderId) {
    io.to(`rider:${riderId}`).emit(event, data);
    log(`Pushing [${event}] to Rider Channel: ${riderId}`);
  }
}

// RESTful API Tier
app.get("/rides", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM rides ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/rides/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM rides WHERE id=$1", [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: "Ride not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/rides", async (req, res) => {
  const { pickup, dropoff, riderId, offered_fare } = req.body;
  const fare = Math.max(15, parseFloat(offered_fare) || 15);
  try {
    const result = await pool.query(
      "INSERT INTO rides (pickup, dropoff, status, rider_id, offered_fare) VALUES ($1,$2,'requested',$3,$4) RETURNING *",
      [pickup, dropoff, riderId || 1, fare]
    );
    const ride = result.rows[0];
    io.to("drivers").emit("new-ride", ride);
    notifyRider(ride.rider_id, "ride-created", ride);
    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/rides/:id/offer", async (req, res) => {
  const { fare_offer, driverId, driver_name } = req.body;
  const fare = Math.max(15, parseFloat(fare_offer) || 15);
  try {
    const result = await pool.query("SELECT * FROM rides WHERE id=$1", [req.params.id]);
    const ride = result.rows[0];
    if (!ride) return res.status(404).json({ error: "Ride not found" });
    const offer = { rideId: ride.id, driverId, driver_name, fare_offer: fare, pickup: ride.pickup, dropoff: ride.dropoff };
    notifyRider(ride.rider_id, "driver-offer", offer);
    io.to(`driver:${driverId}`).emit("offer-sent", { rideId: ride.id });
    res.json({ success: true, offer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/rides/:id/accept-offer", async (req, res) => {
  const { driverId, fare } = req.body;
  try {
    const result = await pool.query(
      "UPDATE rides SET status='accepted', driver_id=$1, fare=$2, fare_accepted=true WHERE id=$3 RETURNING *",
      [driverId, fare, req.params.id]
    );
    const ride = result.rows[0];
    io.to("drivers").emit("ride-updated", ride);
    io.to(`driver:${driverId}`).emit("offer-accepted", ride);
    notifyRider(ride.rider_id, "ride-updated", ride);
    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/rides/:id/decline-offer", async (req, res) => {
  const { driverId } = req.body;
  try {
    const result = await pool.query("SELECT * FROM rides WHERE id=$1", [req.params.id]);
    const ride = result.rows[0];
    io.to(`driver:${driverId}`).emit("offer-declined", { rideId: ride.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/rides/:id/status", async (req, res) => {
  const { status } = req.body;
  const allowed = ["requested","accepted","in_progress","completed","cancelled"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid status" });
  try {
    const result = await pool.query(
      "UPDATE rides SET status=$1 WHERE id=$2 RETURNING *",
      [status, req.params.id]
    );
    const ride = result.rows[0];
    io.to("drivers").emit("ride-updated", ride);
    io.to(`ride:${ride.id}`).emit("ride-updated", ride);
    notifyRider(ride.rider_id, "ride-updated", ride);
    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/drivers", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM drivers ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/drivers/:id/location", async (req, res) => {
  const { lat, lng } = req.body;
  try {
    const result = await pool.query(
      "UPDATE drivers SET lat=$1, lng=$2, last_location_update=NOW() WHERE id=$3 RETURNING *",
      [lat, lng, req.params.id]
    );
    const driver = result.rows[0];
    io.emit("driver-location", { driverId: driver.id, lat: driver.lat, lng: driver.lng });
    res.json(driver);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// VEHICLE TIER
app.get("/vehicles", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT v.*, d.name as driver_name FROM vehicles v
      LEFT JOIN drivers d ON v.driver_id = d.id ORDER BY v.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/vehicles", async (req, res) => {
  const { plate, make, model, type } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO vehicles (plate, make, model, type) VALUES ($1,$2,$3,$4) RETURNING *",
      [plate, make, model, type]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELIVERY TIER
app.get("/deliveries", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.*, dr.name as driver_name FROM deliveries d
      LEFT JOIN drivers dr ON d.driver_id = dr.id ORDER BY d.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/deliveries", async (req, res) => {
  const { sender_name, sender_phone, recipient_name, recipient_phone, pickup_address, dropoff_address, package_description, weight } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO deliveries (sender_name, sender_phone, recipient_name, recipient_phone, pickup_address, dropoff_address, package_description, weight)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [sender_name, sender_phone, recipient_name, recipient_phone, pickup_address, dropoff_address, package_description, weight]
    );
    const delivery = result.rows[0];
    io.to("drivers").emit("new-delivery", delivery);
    res.json(delivery);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deployment and Health Tier
app.get("/api/health", (req, res) => res.json({ status: "READY", system: "Polished-Core-v1.4" }));

const PORT = process.env.PORT || 5000;
server.listen(PORT, "0.0.0.0", () => {
  log(`Railway Core Services active on port ${PORT}`, '\x1b[35m');
});
