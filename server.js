const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const messages = []; // store chat history in memory

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

io.on('connection', (socket) => {
  console.log('a user connected');

  // send chat history to the new user
  socket.emit('chat history', messages);

  socket.on('chat message', (msg) => {
    messages.push(msg);

    // keep only last 50 messages
    if (messages.length > 50) {
      messages.shift();
    }

    io.emit('chat message', msg); // broadcast
  });

  socket.on('disconnect', () => {
    console.log('user disconnected');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`listening on *:${PORT}`);
});
