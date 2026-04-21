const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const pool = require("./db");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);
  socket.on("join-role", ({ role, userId }) => {
    socket.join(role);
    if (role === "drivers") socket.join(`driver:${userId}`);
    if (role.startsWith("rider")) socket.join(`rider:${userId}`);
    console.log("ROLE JOIN:", role, userId);
  });
  socket.on("join-ride", ({ rideId }) => {
    socket.join(`ride:${rideId}`);
    console.log("RIDE JOIN:", rideId);
  });
  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
  });
});

// GET all rides
app.get("/rides", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM rides ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single ride
app.get("/rides/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM rides WHERE id=$1", [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: "Ride not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CREATE ride
app.post("/rides", async (req, res) => {
  const { pickup, dropoff, riderId } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO rides (pickup, dropoff, status) VALUES ($1, $2, 'requested') RETURNING *",
      [pickup, dropoff]
    );
    const ride = result.rows[0];
    io.to("drivers").emit("new-ride", ride);
    if (riderId) io.to(`rider:${riderId}`).emit("ride-created", ride);
    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// OFFER fare (driver proposes fare)
app.post("/rides/:id/offer", async (req, res) => {
  const { fare_offer, driverId } = req.body;
  try {
    const result = await pool.query(
      "UPDATE rides SET fare_offer=$1, status='offered', driver_id=$2 WHERE id=$3 RETURNING *",
      [fare_offer, driverId, req.params.id]
    );
    const ride = result.rows[0];
    io.to("rider").emit("fare-offered", ride);
    io.to("drivers").emit("ride-updated", ride);
    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ACCEPT fare (rider accepts)
app.post("/rides/:id/accept-fare", async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE rides SET fare_accepted=true, status='accepted', fare=fare_offer WHERE id=$1 RETURNING *",
      [req.params.id]
    );
    const ride = result.rows[0];
    io.to("drivers").emit("ride-updated", ride);
    io.to("rider").emit("ride-updated", ride);
    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DECLINE fare (rider declines)
app.post("/rides/:id/decline-fare", async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE rides SET fare_offer=NULL, status='requested', driver_id=NULL WHERE id=$1 RETURNING *",
      [req.params.id]
    );
    const ride = result.rows[0];
    io.to("drivers").emit("new-ride", ride);
    io.to("rider").emit("fare-declined", ride);
    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ACCEPT ride (legacy)
app.post("/rides/accept", async (req, res) => {
  const { rideId, driverId } = req.body;
  try {
    const result = await pool.query(
      "UPDATE rides SET status='accepted', driver_id=$1 WHERE id=$2 RETURNING *",
      [driverId, rideId]
    );
    const ride = result.rows[0];
    io.to("drivers").emit("ride-updated", ride);
    io.to("rider").emit("ride-updated", ride);
    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE ride status
app.patch("/rides/:id/status", async (req, res) => {
  const { status } = req.body;
  const allowed = ["requested", "offered", "accepted", "in_progress", "completed", "cancelled"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid status" });
  try {
    const result = await pool.query(
      "UPDATE rides SET status=$1 WHERE id=$2 RETURNING *",
      [status, req.params.id]
    );
    const ride = result.rows[0];
    io.to("drivers").emit("ride-updated", ride);
    io.to("rider").emit("ride-updated", ride);
    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ASSIGN driver
app.patch("/rides/:id/assign", async (req, res) => {
  const { driver_id } = req.body;
  try {
    const result = await pool.query(
      "UPDATE rides SET driver_id=$1 WHERE id=$2 RETURNING *",
      [driver_id, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET messages for a ride
app.get("/rides/:id/messages", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM messages WHERE ride_id=$1 ORDER BY created_at ASC",
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SEND message
app.post("/rides/:id/messages", async (req, res) => {
  const { sender_role, message } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO messages (ride_id, sender_role, message) VALUES ($1, $2, $3) RETURNING *",
      [req.params.id, sender_role, message]
    );
    const msg = result.rows[0];
    io.to(`ride:${req.params.id}`).emit("new-message", msg);
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET all drivers
app.get("/drivers", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM drivers ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CREATE driver
app.post("/drivers", async (req, res) => {
  const { name, phone } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO drivers (name, phone) VALUES ($1, $2) RETURNING *",
      [name, phone]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TOGGLE driver availability
app.patch("/drivers/:id/availability", async (req, res) => {
  const { available } = req.body;
  try {
    const result = await pool.query(
      "UPDATE drivers SET available=$1 WHERE id=$2 RETURNING *",
      [available, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE driver
app.delete("/drivers/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM drivers WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE driver location
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

// GET all vehicles
app.get("/vehicles", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT v.*, d.name as driver_name
      FROM vehicles v
      LEFT JOIN drivers d ON v.driver_id = d.id
      ORDER BY v.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CREATE vehicle
app.post("/vehicles", async (req, res) => {
  const { plate, make, model, type } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO vehicles (plate, make, model, type) VALUES ($1, $2, $3, $4) RETURNING *",
      [plate, make, model, type]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ASSIGN vehicle
app.patch("/vehicles/:id/assign", async (req, res) => {
  const { driver_id } = req.body;
  try {
    await pool.query("UPDATE vehicles SET driver_id=NULL WHERE driver_id=$1", [driver_id]);
    const result = await pool.query(
      "UPDATE vehicles SET driver_id=$1 WHERE id=$2 RETURNING *",
      [driver_id, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE vehicle status
app.patch("/vehicles/:id/status", async (req, res) => {
  const { status } = req.body;
  const allowed = ["available", "on_trip", "maintenance"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid status" });
  try {
    const result = await pool.query(
      "UPDATE vehicles SET status=$1 WHERE id=$2 RETURNING *",
      [status, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE vehicle
app.delete("/vehicles/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM vehicles WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET all deliveries
app.get("/deliveries", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.*, dr.name as driver_name
      FROM deliveries d
      LEFT JOIN drivers dr ON d.driver_id = dr.id
      ORDER BY d.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CREATE delivery
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

// ACCEPT delivery
app.post("/deliveries/accept", async (req, res) => {
  const { deliveryId, driverId } = req.body;
  try {
    const result = await pool.query(
      "UPDATE deliveries SET status='picked_up', driver_id=$1 WHERE id=$2 RETURNING *",
      [driverId, deliveryId]
    );
    const delivery = result.rows[0];
    io.to("drivers").emit("delivery-updated", delivery);
    res.json(delivery);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE delivery status
app.patch("/deliveries/:id/status", async (req, res) => {
  const { status } = req.body;
  const allowed = ["pending", "picked_up", "in_transit", "delivered", "cancelled"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid status" });
  try {
    const result = await pool.query(
      "UPDATE deliveries SET status=$1 WHERE id=$2 RETURNING *",
      [status, req.params.id]
    );
    const delivery = result.rows[0];
    io.to("drivers").emit("delivery-updated", delivery);
    res.json(delivery);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ASSIGN delivery driver
app.patch("/deliveries/:id/assign", async (req, res) => {
  const { driver_id } = req.body;
  try {
    const result = await pool.query(
      "UPDATE deliveries SET driver_id=$1 WHERE id=$2 RETURNING *",
      [driver_id, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE delivery
app.delete("/deliveries/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM deliveries WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

server.listen(process.env.PORT || 5000, () => {
  console.log("Server running on port", process.env.PORT || 5000);
});
