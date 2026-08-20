'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const config = require('./src/config');
const { initSocket } = require('./src/socket');
const { startActivityStream } = require('./src/activityStream');
const { startDigestScheduler } = require('./src/digest');

const authRoutes = require('./src/routes/auth');
const profileRoutes = require('./src/routes/profile');
const userRoutes = require('./src/routes/users');
const socialRoutes = require('./src/routes/social');
const adminRoutes = require('./src/routes/admin');
const contentRoutes = require('./src/routes/content');
const leaderboardRoutes = require('./src/routes/leaderboard');
const eventsRoutes = require('./src/routes/events');
const groupRoutes = require('./src/routes/groups');
const roleplayRoutes = require('./src/routes/roleplay');
const matchRoutes = require('./src/routes/match');
const broadcastRoutes = require('./src/routes/broadcast');
const adsRoutes = require('./src/routes/ads');
const highwayRoutes = require('./src/routes/highway');
const pageRoutes = require('./src/routes/pages');

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
        // Allow external images/video links shared in chat to render inline.
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        mediaSrc: ["'self'", 'blob:', 'data:', 'https:'],
        // Allow YouTube links shared in chat to embed as players.
        frameSrc: ["'self'", 'https://www.youtube-nocookie.com', 'https://www.youtube.com'],
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
app.use('/api/groups', groupRoutes);
app.use('/api/roleplay', roleplayRoutes);
app.use('/api/match', matchRoutes); // public: shared compatibility-quiz links
app.use('/api/broadcast', broadcastRoutes); // public: directory of live broadcasts
app.use('/api/ads', adsRoutes); // public: serve ads + log clicks
app.use('/api/highway', highwayRoutes); // registered users: shared post pool

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Static SPA.
const publicDir = path.join(config.root, 'public');

// Admin dashboard is its own small SPA. Serve it for /admin and /admin/* (e.g.
// the /admin/reset?token=... link) before the main SPA fallback below.
app.get(/^\/admin(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

// Shared compatibility-quiz link (/m/<token>). Its own tiny standalone page so
// it works for logged-out recipients without the auth-gated main SPA.
app.get(/^\/m(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(publicDir, 'match.html'));
});

// Live broadcast pages: /live (directory of active broadcasts) and
// /live/<token> (watch a broadcast). A standalone page so logged-out visitors
// can watch, comment and share without the auth-gated main SPA.
app.get(/^\/live(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(publicDir, 'live.html'));
});

// Public, server-rendered, crawlable pages + sitemap.xml + robots.txt. Mounted
// before static/SPA so `/` gets injected canonical+OG meta and /quizzes, /polls,
// /blog and content detail URLs return real HTML for search engines. Requests
// with no matching page route fall through to the static assets and SPA below.
app.use(pageRoutes);

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
startActivityStream(); // continuous, shared "recent activity" generator
startDigestScheduler(); // daily offline-activity email digest

server.listen(config.port, () => {
  console.log(`getxmatch listening on http://localhost:${config.port} (${config.env})`);
});
