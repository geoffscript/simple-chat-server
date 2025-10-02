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

// Serve index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// Registration endpoint
app.post("/register", async (req, res) => {
  const { username, password, profileUrl } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, profile_url) VALUES ($1, $2, $3) RETURNING id, username, profile_url, about_me`,
      [username, hashedPassword, profileUrl || ""]
    );
    const user = {
      id: result.rows[0].id,
      username: result.rows[0].username,
      profileUrl: result.rows[0].profile_url,
      aboutMe: result.rows[0].about_me || "",
    };
    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    if (err.code === "23505") res.json({ success: false, message: "Username taken" });
    else res.json({ success: false, message: "Server error" });
  }
});

// Login endpoint
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
    if (result.rows.length === 0)
      return res.json({ success: false, message: "Invalid username or password" });

    const userDb = result.rows[0];
    const match = await bcrypt.compare(password, userDb.password_hash);
    if (!match) return res.json({ success: false, message: "Invalid username or password" });

    const user = {
      id: userDb.id,
      username: userDb.username,
      profileUrl: userDb.profile_url || "",
      aboutMe: userDb.about_me || "",
    };
    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Server error" });
  }
});

// API endpoint for profile page
app.get("/api/user/:username", async (req, res) => {
  const { username } = req.params;
  try {
    const result = await pool.query(
      `SELECT username, profile_url, about_me FROM users WHERE username = $1`,
      [username]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "User not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Update "About Me" for logged-in user
app.post("/api/user/:username/about", async (req, res) => {
  const { username } = req.params;
  const { about_me } = req.body;

  // In a real app, check session/authentication here
  try {
    const result = await pool.query(
      `UPDATE users SET about_me = $1 WHERE username = $2 RETURNING username, profile_url, about_me`,
      [about_me, username]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "User not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Optional endpoint to get logged-in user
app.get("/api/me", async (req, res) => {
  // For now, this is a placeholder; in real apps, you'd check a session or JWT
  res.status(200).json({ username: null }); 
});

// Serve profile page
app.get("/profile/:username", (req, res) => {
  res.sendFile(path.join(__dirname, "public/profile.html"));
});

// Chat messages (keep last 50 in memory)
let messages = [];

io.on("connection", (socket) => {
  console.log("a user connected");
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
