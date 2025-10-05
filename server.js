const express = require("express");
const session = require("express-session"); // NEW
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const path = require("path");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// --- Sessions ---
app.use(
  session({
    secret: "supersecretkey", // you can change this to anything
    resave: false,
    saveUninitialized: true,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      secure: false, // set true if using HTTPS only
    },
  })
);

// --- PostgreSQL Connection ---
const pool = new Pool({
  host: "dpg-d3e1sqje5dus73fcfl90-a.oregon-postgres.render.com",
  user: "chat_db_jl78_user",
  password: "RD8FlriCPhC8qvl3ooTUXdZxXMAOe2wg",
  database: "chat_db_jl78",
  port: 5432,
  ssl: { rejectUnauthorized: false },
});

// Default About Me text
const DEFAULT_ABOUT_ME = "This user hasn’t written anything yet.";

// --- Serve index.html ---
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// --- Register ---
app.post("/register", async (req, res) => {
  const { username, password, profileUrl } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, profile_url, about_me)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, profile_url, about_me`,
      [username, hashedPassword, profileUrl || "", DEFAULT_ABOUT_ME]
    );

    const user = {
      id: result.rows[0].id,
      username: result.rows[0].username,
      profileUrl: result.rows[0].profile_url,
      aboutMe: result.rows[0].about_me,
    };

    // Save to session
    req.session.user = user;
    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    if (err.code === "23505")
      res.json({ success: false, message: "Username taken" });
    else res.json({ success: false, message: "Server error" });
  }
});

// --- Login ---
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query(
      `SELECT * FROM users WHERE username = $1`,
      [username]
    );
    if (result.rows.length === 0)
      return res.json({ success: false, message: "Invalid username or password" });

    const userDb = result.rows[0];
    const match = await bcrypt.compare(password, userDb.password_hash);
    if (!match)
      return res.json({ success: false, message: "Invalid username or password" });

    const user = {
      id: userDb.id,
      username: userDb.username,
      profileUrl: userDb.profile_url || "",
      aboutMe: userDb.about_me || DEFAULT_ABOUT_ME,
    };

    // Save to session
    req.session.user = user;
    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Server error" });
  }
});

// --- Logout ---
app.post("/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// --- Get current logged-in user ---
app.get("/api/me", (req, res) => {
  if (req.session.user) res.json(req.session.user);
  else res.status(200).json({ username: null });
});

// --- Get user profile ---
app.get("/api/user/:username", async (req, res) => {
  const { username } = req.params;
  try {
    const result = await pool.query(
      `SELECT username, profile_url, about_me FROM users WHERE username = $1`,
      [username]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "User not found" });

    const user = result.rows[0];
    if (!user.about_me) user.about_me = DEFAULT_ABOUT_ME;

    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// --- Update "About Me" ---
app.post("/api/user/:username/about", async (req, res) => {
  const { username } = req.params;
  const { about_me } = req.body;

  // Only allow the logged-in user to update their own profile
  if (!req.session.user || req.session.user.username !== username) {
    return res.status(403).json({ error: "Not authorized" });
  }

  try {
    const result = await pool.query(
      `UPDATE users SET about_me = $1 WHERE username = $2 RETURNING username, profile_url, about_me`,
      [about_me, username]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "User not found" });

    // Update session
    req.session.user.aboutMe = about_me;

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// --- Serve profile page ---
app.get("/profile/:username", (req, res) => {
  res.sendFile(path.join(__dirname, "public/profile.html"));
});

// --- Chat logic ---
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
