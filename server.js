const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL // Render PostgreSQL URL
});

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve login/register page
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Registration endpoint
app.post('/register', async (req, res) => {
  const { username, password, profileUrl } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash, profile_url) VALUES ($1, $2, $3) RETURNING id',
      [username, hashedPassword, profileUrl]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    if (err.code === '23505') { // unique violation
      res.json({ success: false, error: 'Username already taken' });
    } else {
      res.json({ success: false, error: 'Server error' });
    }
  }
});

// Login endpoint
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.json({ success: false, error: 'Invalid username or password' });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (match) {
      res.json({ success: true, user: { id: user.id, username: user.username, profileUrl: user.profile_url } });
    } else {
      res.json({ success: false, error: 'Invalid username or password' });
    }
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: 'Server error' });
  }
});

// Store last 50 messages in memory
let messages = [];

// Socket.io chat handling
io.on('connection', (socket) => {
  socket.emit('chat history', messages);

  socket.on('chat message', (msg) => {
    messages.push(msg);
    if (messages.length > 50) messages.shift();
    io.emit('chat message', msg);
  });

  socket.on('disconnect', () => {
    console.log('user disconnected');
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
