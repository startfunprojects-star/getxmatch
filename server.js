'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const config = require('./src/config');
const { initSocket } = require('./src/socket');
const { startDigestScheduler } = require('./src/digest');
const nsfw = require('./src/nsfw');

const authRoutes = require('./src/routes/auth');
const profileRoutes = require('./src/routes/profile');
const userRoutes = require('./src/routes/users');
const socialRoutes = require('./src/routes/social');
const adminRoutes = require('./src/routes/admin');
const contentRoutes = require('./src/routes/content');
const leaderboardRoutes = require('./src/routes/leaderboard');
const eventsRoutes = require('./src/routes/events');
const groupRoutes = require('./src/routes/groups');
const matchRoutes = require('./src/routes/match');
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
        // ws/wss for socket.io; stun/turn so WebRTC screen sharing can reach
        // ICE servers (Chrome checks ICE URLs against connect-src).
        connectSrc: ["'self'", 'ws:', 'wss:', 'stun:', 'turn:', 'turns:'],
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
// Uploaded pictures and videos load inside pages only: opening one directly
// in a browser tab (address bar, "Open image in new tab") is refused, so
// members' photos aren't one click from "Save as". Requests without fetch
// metadata (link-preview crawlers, older browsers) are still served.
app.use('/uploads', (req, res, next) => {
  if (req.get('sec-fetch-dest') === 'document') return res.status(403).type('text').send('This picture can only be viewed on getxmatch.');
  next();
});
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
app.use('/api/notifications', require('./src/routes/notifications'));
app.use('/api/follow', require('./src/routes/follows'));
app.use('/api/match', matchRoutes); // public: shared compatibility-quiz links
app.use('/api/ads', adsRoutes); // public: serve ads + log clicks
app.use('/api/highway', highwayRoutes); // registered users: shared post pool
require('./src/referrals').backfill(); // every member gets a fixed referral code
require('./src/news').start(); // fetch interest-based news for Recent Activity
require('./src/alerts').start(); // fetch keyword alerts for Recent Activity
require('./src/jobs').start(); // fetch job openings for the Alerts panel
app.use('/api/geo', require('./src/routes/geo')); // public: state / city lists for the location picker

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
nsfw.start(); // load the NSFW image classifier in its worker thread
startDigestScheduler(); // daily offline-activity email digest

server.listen(config.port, () => {
  console.log(`getxmatch listening on http://localhost:${config.port} (${config.env})`);
});
