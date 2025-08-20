const express = require('express');
const socketio = require('socket.io');
const http = require('http');
const path = require('path');
const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config()

const app = express();
const server = http.createServer(app);
const io = socketio(server);
//  process.env.
// إعداد اتصال قاعدة البيانات
const pool = mysql.createPool({
    host: process.env.HOST,
    user: process.env.USER,
    password: process.env.PASSWORD,
    database: process.env.DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// تهيئة قاعدة البيانات
async function initializeDatabase() {
    try {
        const connection = await pool.getConnection();

        await connection.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                fingerprint VARCHAR(255) NOT NULL UNIQUE,
                username VARCHAR(255) NOT NULL,
                gender ENUM('ذكر', 'أنثى') NOT NULL,
                is_online BOOLEAN DEFAULT TRUE,
                is_banned BOOLEAN DEFAULT FALSE,
                current_partner_id VARCHAR(255),
                socket_id VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await connection.query(`
            CREATE TABLE IF NOT EXISTS active_chats (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user1_fingerprint VARCHAR(255) NOT NULL,
                user2_fingerprint VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user1_fingerprint) REFERENCES users(fingerprint),
                FOREIGN KEY (user2_fingerprint) REFERENCES users(fingerprint)
            )
        `);

        await connection.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                chat_id INT,
                sender_fingerprint VARCHAR(255) NOT NULL,
                message TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (chat_id) REFERENCES active_chats(id),
                FOREIGN KEY (sender_fingerprint) REFERENCES users(fingerprint)
            )
        `);

        connection.release();
        console.log('تم تهيئة قاعدة البيانات بنجاح');
    } catch (error) {
        console.error('خطأ في تهيئة قاعدة البيانات:', error);
    }
}

initializeDatabase();

app.use(express.static(path.join(__dirname, 'public')));

// إنشاء أسماء عشوائية من حروف
function generateRandomName() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return 'user_' + result;
}

// تحسين نظام الانتظار
const waitingUsers = new Map();
const activeChats = new Map();

io.on('connection', (socket) => {
    console.log('مستخدم جديد متصل:', socket.id);

    socket.on('register', async (data) => {
        try {
            const { gender, fingerprint } = data;

            // التحقق من وجود المستخدم في قاعدة البيانات
            const [existingUser] = await pool.query(
                'SELECT * FROM users WHERE fingerprint = ?',
                [fingerprint]
            );

            if (existingUser.length > 0) {
                // المستخدم موجود بالفعل
                const user = existingUser[0];

                // التحقق من حظر المستخدم
                if (user.is_banned) {
                    socket.emit('banned', { message: 'تم حظرك من استخدام الخدمة' });
                    socket.disconnect();
                    return;
                }

                // تحديث حالة الاتصال للمستخدم
                await pool.query(
                    'UPDATE users SET is_online = TRUE, socket_id = ? WHERE fingerprint = ?',
                    [socket.id, fingerprint]
                );

                socket.fingerprint = fingerprint;
                socket.username = user.username;
                socket.gender = user.gender;

                // إرسال تأكيد الاتصال
                socket.emit('registration-complete', {
                    fingerprint,
                    username: user.username,
                    gender: user.gender
                });
            } else {
                // مستخدم جديد
                const newFingerprint = fingerprint || uuidv4();
                const randomUsername = generateRandomName();

                // حفظ المستخدم في قاعدة البيانات
                const [result] = await pool.query(
                    'INSERT INTO users (fingerprint, username, gender, socket_id) VALUES (?, ?, ?, ?)',
                    [newFingerprint, randomUsername, gender, socket.id]
                );

                socket.fingerprint = newFingerprint;
                socket.username = randomUsername;
                socket.gender = gender;

                // إرسال البصمة للمستخدم
                socket.emit('registration-complete', {
                    fingerprint: newFingerprint,
                    username: randomUsername,
                    gender
                });
            }

            // البحث عن شريك محادثة
            await findChatPartner(socket);

        } catch (err) {
            console.error('خطأ في تسجيل المستخدم:', err);
            socket.emit('registration-error', { message: 'حدث خطأ أثناء التسجيل' });
        }
    });

    async function findChatPartner(socket) {
        try {
            // البحث عن أي مستخدم في قائمة الانتظار (بغض النظر عن الجنس)
            // مع استثناء المستخدم الحالي نفسه
            for (const [waitingSocketId, waitingSocket] of waitingUsers) {
                if (waitingSocketId !== socket.id && waitingSocket.fingerprint !== socket.fingerprint) {
                    // إزالة المستخدم من قائمة الانتظار
                    waitingUsers.delete(waitingSocketId);

                    // ربط المستخدمين معاً
                    activeChats.set(socket.id, waitingSocketId);
                    activeChats.set(waitingSocketId, socket.id);

                    // حفظ المحادثة في قاعدة البيانات
                    const [chatResult] = await pool.query(
                        'INSERT INTO active_chats (user1_fingerprint, user2_fingerprint) VALUES (?, ?)',
                        [socket.fingerprint, waitingSocket.fingerprint]
                    );

                    const chatId = chatResult.insertId;

                    // تحديث حالة المستخدمين
                    await pool.query(
                        'UPDATE users SET current_partner_id = ?, is_online = TRUE WHERE fingerprint IN (?, ?)',
                        [chatId, socket.fingerprint, waitingSocket.fingerprint]
                    );

                    // إخطار كلا المستخدمين (بدون إظهار جنس الشريك)
                    socket.emit('chat-started', {
                        partnerUsername: waitingSocket.username,
                        chatId
                    });

                    waitingSocket.emit('chat-started', {
                        partnerUsername: socket.username,
                        chatId
                    });

                    return;
                }
            }

            // لا يوجد شريك متاح، أضف المستخدم لقائمة الانتظار
            waitingUsers.set(socket.id, socket);
            socket.emit('waiting-for-partner');

            // ضبط مهلة انتظار (5 دقائق)
            setTimeout(() => {
                if (waitingUsers.has(socket.id) && !activeChats.has(socket.id)) {
                    waitingUsers.delete(socket.id);
                    socket.emit('waiting-timeout');
                    console.log(`انتهت مهلة انتظار المستخدم ${socket.id}`);
                }
            }, 5 * 60 * 1000);
        } catch (err) {
            console.error('خطأ في البحث عن شريك:', err);
            socket.emit('partner-search-error', { message: 'حدث خطأ أثناء البحث عن شريك' });
        }
    }

    socket.on('send-message', async (data) => {
        try {
            if (!data || !data.message || !data.chatId) {
                console.error('بيانات غير صالحة:', data);
                return;
            }

            const { message, chatId } = data;
            const partnerId = activeChats.get(socket.id);

            if (partnerId && message.trim() !== '') {
                // حفظ الرسالة في قاعدة البيانات
                await pool.query(
                    'INSERT INTO messages (chat_id, sender_fingerprint, message) VALUES (?, ?, ?)',
                    [chatId, socket.fingerprint, message]
                );

                // إرسال الرسالة للشريك
                io.to(partnerId).emit('new-message', {
                    username: socket.username,
                    message,
                    isMe: false
                });

                // إرسال نسخة للمرسل
                socket.emit('new-message', {
                    username: socket.username,
                    message,
                    isMe: true
                });
            }
        } catch (err) {
            console.error('خطأ في إرسال الرسالة:', err);
        }
    });

    socket.on('disconnect-partner', async () => {
        try {
            const partnerId = activeChats.get(socket.id);
            if (partnerId) {
                // الحصول على معلومات المحادثة
                const [chats] = await pool.query(
                    'SELECT id FROM active_chats WHERE (user1_fingerprint = ? AND user2_fingerprint = ?) OR (user1_fingerprint = ? AND user2_fingerprint = ?)',
                    [socket.fingerprint, io.sockets.sockets.get(partnerId)?.fingerprint,
                    io.sockets.sockets.get(partnerId)?.fingerprint, socket.fingerprint]
                );

                if (chats.length > 0) {
                    const chatId = chats[0].id;

                    // إرسال إشعار انفصال للشريك
                    io.to(partnerId).emit('partner-disconnected');

                    // حذف المحادثة من قاعدة البيانات
                    await pool.query('DELETE FROM messages WHERE chat_id = ?', [chatId]);

                    // تحديث حالة المستخدمين
                    await pool.query(
                        'UPDATE users SET current_partner_id = NULL WHERE fingerprint IN (?, ?)',
                        [socket.fingerprint, io.sockets.sockets.get(partnerId)?.fingerprint]
                    );
                }

                activeChats.delete(partnerId);
                activeChats.delete(socket.id);

                // إعلام المستخدم بقطع الاتصال
                socket.emit('disconnected-successfully');
            }
        } catch (err) {
            console.error('خطأ أثناء قطع الاتصال:', err);
        }
    });

    socket.on('disconnect', async () => {
        try {
            if (socket.fingerprint) {
                // إنهاء المحادثة الحالية إن وجدت
                const partnerId = activeChats.get(socket.id);
                if (partnerId) {
                    // الحصول على معلومات المحادثة
                    const [chats] = await pool.query(
                        'SELECT id FROM active_chats WHERE (user1_fingerprint = ? AND user2_fingerprint = ?) OR (user1_fingerprint = ? AND user2_fingerprint = ?)',
                        [socket.fingerprint, io.sockets.sockets.get(partnerId)?.fingerprint,
                        io.sockets.sockets.get(partnerId)?.fingerprint, socket.fingerprint]
                    );

                    if (chats.length > 0) {
                        const chatId = chats[0].id;

                        // إرسال إشعار انفصال للشريك
                        io.to(partnerId).emit('partner-disconnected');

                        // حذف المحادثة من قاعدة البيانات
                        await pool.query('DELETE FROM messages WHERE chat_id = ?', [chatId]);

                        // تحديث حالة المستخدمين
                        await pool.query(
                            'UPDATE users SET current_partner_id = NULL WHERE fingerprint IN (?, ?)',
                            [socket.fingerprint, io.sockets.sockets.get(partnerId)?.fingerprint]
                        );
                    }

                    activeChats.delete(partnerId);
                    activeChats.delete(socket.id);
                }

                // إزالة المستخدم من قائمة الانتظار
                waitingUsers.delete(socket.id);

                // تحديث حالة المستخدم في قاعدة البيانات
                await pool.query(
                    'UPDATE users SET is_online = FALSE, socket_id = NULL WHERE fingerprint = ?',
                    [socket.fingerprint]
                );

                console.log(`تم قطع اتصال المستخدم: ${socket.id}`);
            }
        } catch (err) {
            console.error('خطأ أثناء قطع الاتصال:', err);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`الخادم يعمل على المنفذ ${PORT}`);
});
