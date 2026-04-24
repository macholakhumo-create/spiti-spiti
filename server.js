const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const pool = require("./db");
const bcrypt = require("bcryptjs");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);
  socket.on("join-role", ({ role, userId }) => {
    socket.join(role);
    if (role === "drivers") socket.join(`driver:${userId}`);
    if (role === "rider") socket.join(`rider:${userId}`);
    console.log("ROLE JOIN:", role, userId, [...socket.rooms]);
  });
  socket.on("join-ride", ({ rideId }) => {
    socket.join(`ride:${rideId}`);
    console.log("RIDE JOIN:", rideId);
  });
  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
  });
});

function notifyRider(riderId, event, data) {
  if (riderId) {
    io.to(`rider:${riderId}`).emit(event, data);
    console.log(`Emitting ${event} to rider:${riderId}`);
  }
}

// ─── AUTH ROUTES ─────────────────────────────────────────────

// ADMIN LOGIN
app.post("/auth/admin/login", async (req, res) => {
  const { username, password } = req.body;
  const correctUser = process.env.ADMIN_USERNAME || "Spiti-Spiti2026";
  const correctPass = process.env.ADMIN_PASSWORD || "Oloratomachola20";
  if (username === correctUser && password === correctPass) {
    return res.json({ success: true, role: "admin", name: "Admin" });
  }
  res.status(401).json({ error: "Invalid credentials" });
});

// RIDER SIGNUP
app.post("/auth/rider/signup", async (req, res) => {
  const { name, phone, id_number, password } = req.body;
  if (!name || !phone || !id_number || !password) {
    return res.status(400).json({ error: "All fields required" });
  }
  try {
    const exists = await pool.query("SELECT id FROM riders WHERE phone=$1", [phone]);
    if (exists.rows.length) return res.status(400).json({ error: "Phone already registered" });
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO riders (name, phone, id_number, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, name, phone",
      [name, phone, id_number, hash]
    );
    res.json({ success: true, rider: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// RIDER LOGIN
app.post("/auth/rider/login", async (req, res) => {
  const { phone, password } = req.body;
  try {
    const result = await pool.query("SELECT * FROM riders WHERE phone=$1", [phone]);
    if (!result.rows.length) return res.status(401).json({ error: "Phone not registered" });
    const rider = result.rows[0];
    const match = await bcrypt.compare(password, rider.password_hash);
    if (!match) return res.status(401).json({ error: "Incorrect password" });
    res.json({ success: true, rider: { id: rider.id, name: rider.name, phone: rider.phone } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DRIVER SIGNUP
app.post("/auth/driver/signup", async (req, res) => {
  const { name, phone, id_number, license_number, password } = req.body;
  if (!name || !phone || !id_number || !license_number || !password) {
    return res.status(400).json({ error: "All fields required" });
  }
  try {
    const exists = await pool.query("SELECT id FROM drivers WHERE phone=$1", [phone]);
    if (exists.rows.length) return res.status(400).json({ error: "Phone already registered" });
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO drivers (name, phone, id_number, license_number, password_hash, approved, available) VALUES ($1,$2,$3,$4,$5,false,false) RETURNING id, name, phone, approved",
      [name, phone, id_number, license_number, hash]
    );
    res.json({ success: true, driver: result.rows[0], message: "Account created! Awaiting admin approval." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DRIVER LOGIN
app.post("/auth/driver/login", async (req, res) => {
  const { phone, password } = req.body;
  try {
    const result = await pool.query("SELECT * FROM drivers WHERE phone=$1", [phone]);
    if (!result.rows.length) return res.status(401).json({ error: "Phone not registered" });
    const driver = result.rows[0];
    const match = await bcrypt.compare(password, driver.password_hash);
    if (!match) return res.status(401).json({ error: "Incorrect password" });
    if (!driver.approved) return res.status(403).json({ error: "Account pending approval. Please wait for admin to approve your account." });
    res.json({ success: true, driver: { id: driver.id, name: driver.name, phone: driver.phone, license_number: driver.license_number } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET pending drivers (for admin)
app.get("/auth/drivers/pending", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, phone, id_number, license_number, created_at FROM drivers WHERE approved=false ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// APPROVE driver
app.patch("/auth/drivers/:id/approve", async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE drivers SET approved=true, available=true WHERE id=$1 RETURNING id, name, phone, approved",
      [req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REJECT driver
app.delete("/auth/drivers/:id/reject", async (req, res) => {
  try {
    await pool.query("DELETE FROM drivers WHERE id=$1 AND approved=false", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RIDE ROUTES ─────────────────────────────────────────────

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
    io.to(`ride:${ride.id}`).emit("ride-updated", ride);
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
  const allowed = ["requested", "accepted", "in_progress", "completed", "cancelled"];
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

app.patch("/rides/:id/assign", async (req, res) => {
  const { driver_id } = req.body;
  try {
    const result = await pool.query("UPDATE rides SET driver_id=$1 WHERE id=$2 RETURNING *", [driver_id, req.params.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/rides/:id/messages", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM messages WHERE ride_id=$1 ORDER BY created_at ASC", [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/rides/:id/messages", async (req, res) => {
  const { sender_role, message } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO messages (ride_id, sender_role, message) VALUES ($1,$2,$3) RETURNING *",
      [req.params.id, sender_role, message]
    );
    const msg = result.rows[0];
    io.to(`ride:${req.params.id}`).emit("new-message", msg);
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DRIVER ROUTES ────────────────────────────────────────────

app.get("/drivers", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM drivers WHERE approved=true ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/drivers", async (req, res) => {
  const { name, phone } = req.body;
  try {
    const result = await pool.query("INSERT INTO drivers (name, phone) VALUES ($1,$2) RETURNING *", [name, phone]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/drivers/:id/availability", async (req, res) => {
  const { available } = req.body;
  try {
    const result = await pool.query("UPDATE drivers SET available=$1 WHERE id=$2 RETURNING *", [available, req.params.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/drivers/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM drivers WHERE id=$1", [req.params.id]);
    res.json({ success: true });
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

app.get("/drivers/:id/location", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, lat, lng FROM drivers WHERE id=$1", [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: "Driver not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── VEHICLE ROUTES ───────────────────────────────────────────

app.get("/vehicles", async (req, res) => {
  try {
    const result = await pool.query(`SELECT v.*, d.name as driver_name FROM vehicles v LEFT JOIN drivers d ON v.driver_id = d.id ORDER BY v.id DESC`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/vehicles", async (req, res) => {
  const { plate, make, model, type } = req.body;
  try {
    const result = await pool.query("INSERT INTO vehicles (plate, make, model, type) VALUES ($1,$2,$3,$4) RETURNING *", [plate, make, model, type]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/vehicles/:id/assign", async (req, res) => {
  const { driver_id } = req.body;
  try {
    await pool.query("UPDATE vehicles SET driver_id=NULL WHERE driver_id=$1", [driver_id]);
    const result = await pool.query("UPDATE vehicles SET driver_id=$1 WHERE id=$2 RETURNING *", [driver_id, req.params.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/vehicles/:id/status", async (req, res) => {
  const { status } = req.body;
  const allowed = ["available", "on_trip", "maintenance"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid status" });
  try {
    const result = await pool.query("UPDATE vehicles SET status=$1 WHERE id=$2 RETURNING *", [status, req.params.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/vehicles/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM vehicles WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELIVERY ROUTES ──────────────────────────────────────────

app.get("/deliveries", async (req, res) => {
  try {
    const result = await pool.query(`SELECT d.*, dr.name as driver_name FROM deliveries d LEFT JOIN drivers dr ON d.driver_id = dr.id ORDER BY d.id DESC`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/deliveries", async (req, res) => {
  const { sender_name, sender_phone, recipient_name, recipient_phone, pickup_address, dropoff_address, package_description, weight } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO deliveries (sender_name, sender_phone, recipient_name, recipient_phone, pickup_address, dropoff_address, package_description, weight) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [sender_name, sender_phone, recipient_name, recipient_phone, pickup_address, dropoff_address, package_description, weight]
    );
    const delivery = result.rows[0];
    io.to("drivers").emit("new-delivery", delivery);
    res.json(delivery);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/deliveries/accept", async (req, res) => {
  const { deliveryId, driverId } = req.body;
  try {
    const result = await pool.query("UPDATE deliveries SET status='picked_up', driver_id=$1 WHERE id=$2 RETURNING *", [driverId, deliveryId]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/deliveries/:id/status", async (req, res) => {
  const { status } = req.body;
  const allowed = ["pending", "picked_up", "in_transit", "delivered", "cancelled"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid status" });
  try {
    const result = await pool.query("UPDATE deliveries SET status=$1 WHERE id=$2 RETURNING *", [status, req.params.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/deliveries/:id/assign", async (req, res) => {
  const { driver_id } = req.body;
  try {
    const result = await pool.query("UPDATE deliveries SET driver_id=$1 WHERE id=$2 RETURNING *", [driver_id, req.params.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/deliveries/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM deliveries WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START SERVER ─────────────────────────────────────────────

server.listen(process.env.PORT || 5000, () => {
  console.log("Server running on port", process.env.PORT || 5000);
});