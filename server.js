const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const path = require("path");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  host: "dpg-d3e1sqje5dus73fcfl90-a.oregon-postgres.render.com",
  user: "chat_db_jl78_user",
  password: "RD8FlriCPhC8qvl3ooTUXdZxXMAOe2wg",
  database: "chat_db_jl78",
  port: 5432,
  ssl: { rejectUnauthorized: false },
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// Registration endpoint
app.post("/register", async (req, res) => {
  const { username, password, profile_url } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, profile_url) VALUES ($1, $2, $3) RETURNING *`,
      [username, hashedPassword, profile_url || ""]
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    if (err.code === "23505") {
      res.json({ success: false, message: "Username taken" });
    } else {
      res.json({ success: false, message: "Server error" });
    }
  }
});

// Login endpoint
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query(
      `SELECT * FROM users WHERE username = $1`,
      [username]
    );
    if (result.rows.length === 0) return res.json({ success: false, message: "Invalid username or password" });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.json({ success: false, message: "Invalid username or password" });

    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Server error" });
  }
});

// Chat messages
let messages = []; // Keep last 50 messages in memory

io.on("connection", (socket) => {
  console.log("a user connected");
  // Send last 50 messages to new user
  socket.emit("chat history", messages);

  socket.on("chat message", (msg) => {
    messages.push(msg);
    if (messages.length > 50) messages.shift();
    io.emit("chat message", msg);
  });

  socket.on("disconnect", () => {
    console.log("user disconnected");
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
