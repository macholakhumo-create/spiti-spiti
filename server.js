const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const pool = require("./db");

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
    if (!rideId) return;
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

// ─── RIDES ────────────────────────────────────────────────────────────────────

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
  const { pickup, dropoff, riderId, offered_fare } = req.body;
  if (!pickup || !dropoff) return res.status(400).json({ error: "pickup and dropoff are required" });
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

// DRIVER sends counter offer
app.post("/rides/:id/offer", async (req, res) => {
  const { fare_offer, driverId, driver_name } = req.body;
  if (!driverId) return res.status(400).json({ error: "driverId required" });
  const fare = Math.max(15, parseFloat(fare_offer) || 15);
  try {
    const result = await pool.query("SELECT * FROM rides WHERE id=$1", [req.params.id]);
    const ride = result.rows[0];
    if (!ride) return res.status(404).json({ error: "Ride not found" });
    if (!["requested", "offered"].includes(ride.status)) {
      return res.status(400).json({ error: "Ride is no longer available for offers" });
    }
    const offer = {
      rideId: ride.id,
      driverId,
      driver_name: driver_name || `Driver #${driverId}`,
      fare_offer: fare,
      pickup: ride.pickup,
      dropoff: ride.dropoff
    };
    notifyRider(ride.rider_id, "driver-offer", offer);
    io.to(`driver:${driverId}`).emit("offer-sent", { rideId: ride.id });
    console.log(`Counter offer sent: driver ${driverId} → rider ${ride.rider_id} P${fare}`);
    res.json({ success: true, offer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// RIDER accepts offer
app.post("/rides/:id/accept-offer", async (req, res) => {
  const { driverId, fare } = req.body;
  if (!driverId || !fare) return res.status(400).json({ error: "driverId and fare required" });
  try {
    const result = await pool.query(
      "UPDATE rides SET status='accepted', driver_id=$1, fare=$2, fare_accepted=true WHERE id=$3 RETURNING *",
      [driverId, fare, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Ride not found" });
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

// RIDER declines offer
app.post("/rides/:id/decline-offer", async (req, res) => {
  const { driverId } = req.body;
  if (!driverId) return res.status(400).json({ error: "driverId required" });
  try {
    const result = await pool.query("SELECT * FROM rides WHERE id=$1", [req.params.id]);
    const ride = result.rows[0];
    if (!ride) return res.status(404).json({ error: "Ride not found" });
    io.to(`driver:${driverId}`).emit("offer-declined", { rideId: ride.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE ride status
app.patch("/rides/:id/status", async (req, res) => {
  const { status } = req.body;
  const allowed = ["requested", "accepted", "in_progress", "completed", "cancelled"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid status" });
  try {
    const result = await pool.query(
      "UPDATE rides SET status=$1 WHERE id=$2 RETURNING *",
      [status, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Ride not found" });
    const ride = result.rows[0];
    io.to("drivers").emit("ride-updated", ride);
    io.to(`ride:${ride.id}`).emit("ride-updated", ride);
    notifyRider(ride.rider_id, "ride-updated", ride);
    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ASSIGN driver to ride
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

// ─── MESSAGES ─────────────────────────────────────────────────────────────────

// GET messages for ride
app.get("/rides/:id/messages", async (req, res) => {
  const rideId = parseInt(req.params.id);
  if (isNaN(rideId)) return res.status(400).json({ error: "Invalid ride ID" });
  try {
    const result = await pool.query(
      "SELECT * FROM messages WHERE ride_id=$1 ORDER BY created_at ASC",
      [rideId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SEND message
app.post("/rides/:id/messages", async (req, res) => {
  const rideId = parseInt(req.params.id);
  if (isNaN(rideId)) return res.status(400).json({ error: "Invalid ride ID" });
  const { sender_role, message } = req.body;
  if (!sender_role || !message) return res.status(400).json({ error: "sender_role and message required" });
  try {
    const result = await pool.query(
      "INSERT INTO messages (ride_id, sender_role, message) VALUES ($1,$2,$3) RETURNING *",
      [rideId, sender_role, message]
    );
    const msg = result.rows[0];
    io.to(`ride:${rideId}`).emit("new-message", msg);
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DRIVERS ──────────────────────────────────────────────────────────────────

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
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    const result = await pool.query(
      "INSERT INTO drivers (name, phone) VALUES ($1,$2) RETURNING *",
      [name, phone]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TOGGLE availability
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
  if (lat === undefined || lng === undefined) return res.status(400).json({ error: "lat and lng required" });
  try {
    const result = await pool.query(
      "UPDATE drivers SET lat=$1, lng=$2, last_location_update=NOW() WHERE id=$3 RETURNING *",
      [lat, lng, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Driver not found" });
    const driver = result.rows[0];
    io.emit("driver-location", { driverId: driver.id, lat: driver.lat, lng: driver.lng });
    res.json(driver);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET driver location
app.get("/drivers/:id/location", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, lat, lng FROM drivers WHERE id=$1",
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Driver not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── VEHICLES ─────────────────────────────────────────────────────────────────

// GET all vehicles
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

// CREATE vehicle
app.post("/vehicles", async (req, res) => {
  const { plate, make, model, type } = req.body;
  if (!plate) return res.status(400).json({ error: "plate required" });
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

// ASSIGN vehicle to driver
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

// ─── DELIVERIES ───────────────────────────────────────────────────────────────

// GET all deliveries
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

// CREATE delivery
app.post("/deliveries", async (req, res) => {
  const { sender_name, sender_phone, recipient_name, recipient_phone, pickup_address, dropoff_address, package_description, weight } = req.body;
  if (!pickup_address || !dropoff_address) return res.status(400).json({ error: "pickup_address and dropoff_address required" });
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
  if (!deliveryId || !driverId) return res.status(400).json({ error: "deliveryId and driverId required" });
  try {
    const result = await pool.query(
      "UPDATE deliveries SET status='picked_up', driver_id=$1 WHERE id=$2 RETURNING *",
      [driverId, deliveryId]
    );
    res.json(result.rows[0]);
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
    res.json(result.rows[0]);
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

// ─── START ────────────────────────────────────────────────────────────────────

server.listen(process.env.PORT || 5000, () => {
  console.log("Server running on port", process.env.PORT || 5000);
});
