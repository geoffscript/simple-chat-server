const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.static(__dirname));

// ---------- DATABASE SETUP ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // your Render DB URL
  ssl: { rejectUnauthorized: false } // required on Render
});

// Create tables if they don't exist
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
})();

// ---------- AUTH ENDPOINTS ----------
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).send('Missing username or password');

  try {
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING username',
      [username, hashed]
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(400).send('Username already exists');
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).send('Missing username or password');

  try {
    const result = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    if (result.rows.length === 0) return res.status(400).send('User not found');

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).send('Invalid password');

    res.json({ user: { username: user.username } });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// ---------- CHAT SOCKET ----------
io.on('connection', async (socket) => {
  console.log('a user connected');

  // Send last 50 messages to the new user
  try {
    const result = await pool.query(`
      SELECT username, text, created_at 
      FROM messages
      ORDER BY created_at DESC
      LIMIT 50
    `);

    // Send in chronological order
    result.rows.reverse().forEach(msg => {
      socket.emit('chat message', { user: msg.username, text: msg.text });
    });
  } catch (err) {
    console.error('Error fetching messages', err);
  }

  // Handle incoming messages
  socket.on('chat message', async (msg) => {
    try {
      await pool.query(
        'INSERT INTO messages (username, text) VALUES ($1, $2)',
        [msg.user, msg.text]
      );

      // Keep only last 50 messages
      await pool.query(`
        DELETE FROM messages
        WHERE id NOT IN (
          SELECT id FROM messages
          ORDER BY created_at DESC
          LIMIT 50
        )
      `);

      io.emit('chat message', msg);
    } catch (err) {
      console.error('Error saving message', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('user disconnected');
  });
});

// ---------- SERVE INDEX.HTML ----------
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// ---------- START SERVER ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`listening on *:${PORT}`);
});
