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

// --- Sessions ---
const sessionMiddleware = session({
  secret: "supersecretkey",
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, secure: false },
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

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
const STARTING_XP = 0;
const STARTING_LEVEL = 1;

// --- XP Helper ---
function getNextLevelXP(level) {
  return Math.pow(2, level - 1);
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));

// --- Register ---
app.post("/register", async (req, res) => {
  const { username, password, profileUrl } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, profile_url, about_me, balance, xp, level)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, username, profile_url, about_me, balance, xp, level`,
      [username, hashedPassword, profileUrl || "", DEFAULT_ABOUT_ME, STARTING_BALANCE, STARTING_XP, STARTING_LEVEL]
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
      xp: Number(userDb.xp ?? STARTING_XP),
      level: Number(userDb.level ?? STARTING_LEVEL)
    };

    req.session.user = user;
    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Server error" });
  }
});

// --- Logout ---
app.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// --- Current user ---
app.get("/api/me", async (req, res) => {
  if (!req.session.user) return res.status(200).json({ username: null });
  try {
    const result = await pool.query(
      `SELECT username, profile_url, about_me, balance, xp, level FROM users WHERE username=$1`,
      [req.session.user.username]
    );
    if (!result.rows.length) return res.status(404).json({ username: null });

    const user = result.rows[0];
    req.session.user = {
      ...req.session.user,
      balance: Number(user.balance),
      xp: Number(user.xp),
      level: Number(user.level)
    };
    res.json({
      username: user.username,
      profileUrl: user.profile_url || "",
      aboutMe: user.about_me || DEFAULT_ABOUT_ME,
      balance: Number(user.balance),
      xp: Number(user.xp),
      level: Number(user.level)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ username: null });
  }
});

// --- Faucet ---
app.post("/faucet", async (req, res) => {
  if (!req.session.user) return res.json({ success: false, message: "Not logged in" });
  const username = req.session.user.username;
  try {
    const result = await pool.query(`SELECT balance FROM users WHERE username=$1`, [username]);
    if (!result.rows.length) return res.json({ success: false, message: "User not found" });

    const currentBalance = Number(result.rows[0].balance);
    if (currentBalance > 0) return res.json({ success: false, message: "You still have money left!" });

    const newBalance = 100;
    await pool.query(`UPDATE users SET balance=$1 WHERE username=$2`, [newBalance, username]);
    req.session.user.balance = newBalance;

    io.emit("update balance", { balance: newBalance });
    res.json({ success: true, newBalance });
  } catch (err) {
    console.error("Faucet error:", err);
    res.json({ success: false, message: "Server error" });
  }
});

// --- Leaderboard ---
app.get("/api/leaderboard", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT username, balance, profile_url, level FROM users ORDER BY balance DESC LIMIT 10`
    );
    res.json(result.rows.map(u => ({
      username: u.username,
      balance: Number(u.balance),
      profileUrl: u.profile_url || "",
      level: Number(u.level ?? STARTING_LEVEL)
    })));
  } catch (err) {
    console.error("Error fetching leaderboard:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Profile API ---
app.get("/api/user/:username", async (req, res) => {
  const { username } = req.params;
  try {
    const result = await pool.query(
      `SELECT username, profile_url, about_me, balance, xp, level FROM users WHERE username=$1`,
      [username]
    );
    if (!result.rows.length) return res.status(404).json({ error: "User not found" });

    const user = result.rows[0];
    res.json({
      username: user.username,
      profileUrl: user.profile_url || "",
      aboutMe: user.about_me || DEFAULT_ABOUT_ME,
      balance: Number(user.balance),
      xp: Number(user.xp ?? STARTING_XP),
      level: Number(user.level ?? STARTING_LEVEL)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// --- Update About Me ---
app.post("/api/user/:username/about", async (req, res) => {
  const { username } = req.params;
  const { about_me } = req.body;
  if (!req.session.user || req.session.user.username !== username)
    return res.status(403).json({ error: "Not authorized" });

  try {
    const result = await pool.query(
      `UPDATE users SET about_me=$1 WHERE username=$2 RETURNING username, profile_url, about_me`,
      [about_me, username]
    );
    if (!result.rows.length) return res.status(404).json({ error: "User not found" });

    req.session.user.aboutMe = about_me;
    res.json({
      username: result.rows[0].username,
      profileUrl: result.rows[0].profile_url || "",
      aboutMe: result.rows[0].about_me || DEFAULT_ABOUT_ME
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// --- Profile Comments System ---

// Add a comment
app.post("/api/profile/:username/comment", async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
    const { text } = req.body;
    if (!text || text.trim() === "") return res.status(400).json({ error: "Empty comment" });

    const profileResult = await pool.query("SELECT id FROM users WHERE username = $1", [req.params.username]);
    if (profileResult.rows.length === 0) return res.status(404).json({ error: "User not found" });
    const profileUserId = profileResult.rows[0].id;

    await pool.query(
      "INSERT INTO profile_comments (user_id, profile_user_id, comment_text) VALUES ($1, $2, $3)",
      [req.session.user.id, profileUserId, text.trim()]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Error adding comment:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Get comments
app.get("/api/profile/:username/comments", async (req, res) => {
  try {
    const userRes = await pool.query("SELECT id FROM users WHERE username = $1", [req.params.username]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: "User not found" });
    const profileUserId = userRes.rows[0].id;

    const commentsRes = await pool.query(`
      SELECT c.id, c.comment_text, c.created_at,
             u.username, u.profile_url, u.level
      FROM profile_comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.profile_user_id = $1
      ORDER BY c.created_at DESC
    `, [profileUserId]);

    res.json(commentsRes.rows);
  } catch (err) {
    console.error("Error fetching comments:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Delete comment
app.delete("/api/profile/comments/:id", async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ error: "Not logged in" });

    const commentRes = await pool.query("SELECT * FROM profile_comments WHERE id = $1", [req.params.id]);
    if (commentRes.rows.length === 0) return res.status(404).json({ error: "Comment not found" });
    const comment = commentRes.rows[0];

    const currentUserId = req.session.user.id;
    if (comment.user_id !== currentUserId && comment.profile_user_id !== currentUserId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    await pool.query("DELETE FROM profile_comments WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting comment:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// --- Profile Page ---
app.get("/profile/:username", (req, res) => {
  res.sendFile(path.join(__dirname, "public/profile.html"));
});

// --- Chat with XP/Levels ---
let messages = [];

io.on("connection", (socket) => {
  socket.emit("chat history", messages);

  socket.on("chat message", async (msg) => {
    if (!msg.username) return;

    // /gamble logic (unchanged)
    // ...
    // XP / Leveling (unchanged)
    try {
      const userRes = await pool.query(`SELECT xp, level FROM users WHERE username=$1`, [msg.username]);
      if (userRes.rows.length) {
        let { xp, level } = userRes.rows[0];
        xp += 1;
        const nextXP = getNextLevelXP(level);
        if (xp >= nextXP) {
          level += 1;
          socket.emit("chat message", { username: "System", profileUrl: "", text: `${msg.username} reached Level ${level}! 🎉` });
        }
        await pool.query(`UPDATE users SET xp=$1, level=$2 WHERE username=$3`, [xp, level, msg.username]);
        if (socket.request.session?.user?.username === msg.username) {
          socket.request.session.user.xp = xp;
          socket.request.session.user.level = level;
        }
        msg.level = level;
      }
    } catch (err) { console.error("XP error:", err); }

    messages.push(msg);
    if (messages.length > 50) messages.shift();
    io.emit("chat message", msg);
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
