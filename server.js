const express = require("express");
const session = require("express-session");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const path = require("path");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.use(session({
  secret: "supersecretkey",
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, secure: false },
}));

const pool = new Pool({
  host: "dpg-d3e1sqje5dus73fcfl90-a.oregon-postgres.render.com",
  user: "chat_db_jl78_user",
  password: "RD8FlriCPhC8qvl3ooTUXdZxXMAOe2wg",
  database: "chat_db_jl78",
  port: 5432,
  ssl: { rejectUnauthorized: false },
});

const DEFAULT_ABOUT_ME = "This user hasn’t written anything yet.";
const STARTING_BALANCE = 100;

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));

// --- Register ---
app.post("/register", async (req, res) => {
  const { username, password, profileUrl } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, profile_url, about_me, balance)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, username, profile_url, about_me, balance`,
      [username, hashedPassword, profileUrl || "", DEFAULT_ABOUT_ME, STARTING_BALANCE]
    );
    req.session.user = result.rows[0];
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    if (err.code === "23505") res.json({ success: false, message: "Username taken" });
    else res.json({ success: false, message: "Server error" });
  }
});

// --- Login ---
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query(`SELECT * FROM users WHERE username=$1`, [username]);
    if (!result.rows.length) return res.json({ success: false, message: "Invalid username or password" });
    const userDb = result.rows[0];
    const match = await bcrypt.compare(password, userDb.password_hash);
    if (!match) return res.json({ success: false, message: "Invalid username or password" });

    const user = {
      id: userDb.id,
      username: userDb.username,
      profileUrl: userDb.profile_url || "",
      aboutMe: userDb.about_me || DEFAULT_ABOUT_ME,
      balance: Number(userDb.balance ?? STARTING_BALANCE),
    };

    req.session.user = user;
    res.json({ success: true, user });
  } catch (err) { console.error(err); res.json({ success: false, message: "Server error" }); }
});

// --- Logout ---
app.post("/logout", (req, res) => { req.session.destroy(); res.json({ success: true }); });

// --- Current user (fetch fresh from DB) ---
app.get("/api/me", async (req, res) => {
  if (!req.session.user) return res.status(200).json({ username: null });

  try {
    const result = await pool.query(
      `SELECT username, profile_url, about_me, balance FROM users WHERE username=$1`,
      [req.session.user.username]
    );
    if (!result.rows.length) return res.status(404).json({ username: null });

    const user = result.rows[0];
    if (!user.about_me) user.about_me = DEFAULT_ABOUT_ME;

    // Update session with latest balance
    req.session.user.balance = Number(user.balance);

    res.json({
      username: user.username,
      profileUrl: user.profile_url || "",
      aboutMe: user.about_me,
      balance: Number(user.balance)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ username: null });
  }
});

// --- Profile ---
app.get("/api/user/:username", async (req, res) => {
  const { username } = req.params;
  try {
    const result = await pool.query(
      `SELECT username, profile_url, about_me, balance FROM users WHERE username=$1`,
      [username]
    );
    if (!result.rows.length) return res.status(404).json({ error: "User not found" });
    const user = result.rows[0];
    if (!user.about_me) user.about_me = DEFAULT_ABOUT_ME;
    res.json(user);
  } catch (err) { console.error(err); res.status(500).json({ error: "Server error" }); }
});

// --- Update About Me ---
app.post("/api/user/:username/about", async (req, res) => {
  const { username } = req.params;
  const { about_me } = req.body;
  if (!req.session.user || req.session.user.username !== username) return res.status(403).json({ error: "Not authorized" });
  try {
    const result = await pool.query(
      `UPDATE users SET about_me=$1 WHERE username=$2 RETURNING username, profile_url, about_me`,
      [about_me, username]
    );
    if (!result.rows.length) return res.status(404).json({ error: "User not found" });
    req.session.user.aboutMe = about_me;
    res.json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: "Server error" }); }
});

// --- Profile page ---
app.get("/profile/:username", (req, res) => { res.sendFile(path.join(__dirname, "public/profile.html")); });

// --- Chat and /gamble ---
let messages = [];

io.on("connection", (socket) => {
  console.log("a user connected");
  socket.emit("chat history", messages);

  socket.on("chat message", async (msg) => {
    if (msg.text.startsWith("/gamble")) {
      if (!msg.username) return;
      const parts = msg.text.split(" ");
      const amount = parseInt(parts[1]);
      if (isNaN(amount) || amount <= 0) {
        socket.emit("chat message", { username: "System", profileUrl: "", text: "Invalid gamble amount." });
        return;
      }

      // Fetch balance from DB
      const result = await pool.query(`SELECT balance FROM users WHERE username=$1`, [msg.username]);
      if (!result.rows.length) return;
      let balance = Number(result.rows[0].balance);

      if (amount > balance) {
        socket.emit("chat message", { username: "System", profileUrl: "", text: "You don't have enough money to gamble." });
        return;
      }

      // Gamble 50/50
      const win = Math.random() < 0.5;
      balance = win ? balance + amount : balance - amount;

      // Update DB
      await pool.query(`UPDATE users SET balance=$1 WHERE username=$2`, [balance, msg.username]);

      // Update session if applicable
      if (socket.request.session?.user && socket.request.session.user.username === msg.username) {
        socket.request.session.user.balance = balance;
      }

      // Emit System message
      const resultMsg = win
        ? `You won ${amount}!`
        : `You lost ${amount}!`;
      socket.emit("chat message", { username: "System", profileUrl: "", text: resultMsg });

      // Emit updated balance to user
      socket.emit("update balance", { balance });
      return;
    }

    // Normal chat
    messages.push(msg);
    if (messages.length > 50) messages.shift();
    io.emit("chat message", msg);
  });

  socket.on("disconnect", () => { console.log("user disconnected"); });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
