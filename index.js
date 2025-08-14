const express = require('express');
const socketio = require('socket.io');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketio(server);

app.use(express.static(path.join(__dirname, 'public')));

let users = {};

io.on('connection', (socket) => {
    console.log('مستخدم جديد متصل');

    socket.on('join', (username) => {
        users[socket.id] = username;
        socket.broadcast.emit('user-connected', username);
        io.emit('users-list', Object.values(users));
        console.log(`${username} انضم للدردشة`);
    });

    socket.on('send-message', (message) => {
        const username = users[socket.id];
        // نرسل الرسالة لكل المستخدمين عدا المرسل
        socket.broadcast.emit('new-message', { username, message });
        // نرسل رسالة خاصة للمرسل فقط
        socket.emit('my-message', message);
        console.log(`${username}: ${message}`);
    });

    socket.on('disconnect', () => {
        const username = users[socket.id];
        if (username) {
            socket.broadcast.emit('user-disconnected', username);
            delete users[socket.id];
            io.emit('users-list', Object.values(users));
            console.log(`${username} غادر الدردشة`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`الخادم يعمل على المنفذ ${PORT}`);
});