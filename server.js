'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const config = require('./src/config');
const { initSocket } = require('./src/socket');

const authRoutes = require('./src/routes/auth');
const profileRoutes = require('./src/routes/profile');
const userRoutes = require('./src/routes/users');
const socialRoutes = require('./src/routes/social');
const adminRoutes = require('./src/routes/admin');
const contentRoutes = require('./src/routes/content');
const leaderboardRoutes = require('./src/routes/leaderboard');
const eventsRoutes = require('./src/routes/events');
const discussRoutes = require('./src/routes/discuss');

const app = express();
app.set('trust proxy', 1); // behind nginx on the VPS

// Security headers. CSP tuned to allow the same-origin SPA + socket.io.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Persisted profile & gallery images.
app.use('/uploads', express.static(config.uploadsDir, { maxAge: '7d', index: false }));

// API routes.
app.use('/api/auth', authRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/users', userRoutes);
app.use('/api/social', socialRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/discuss', discussRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Static SPA.
const publicDir = path.join(config.root, 'public');

// Admin dashboard is its own small SPA. Serve it for /admin and /admin/* (e.g.
// the /admin/reset?token=... link) before the main SPA fallback below.
app.get(/^\/admin(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

app.use(express.static(publicDir, { index: 'index.html' }));

// SPA fallback for non-API routes.
app.get(/^(?!\/api|\/uploads).*/, (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Multer / generic error handler.
app.use((err, req, res, next) => {
  if (err && err.message) {
    const code = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(code).json({ error: err.message });
  }
  res.status(500).json({ error: 'Server error' });
});

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: config.maxChatFileBytes + 1024 * 1024, // room for file relay + metadata
});
initSocket(io);

server.listen(config.port, () => {
  console.log(`getxmatch listening on http://localhost:${config.port} (${config.env})`);
});
