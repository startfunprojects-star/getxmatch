# getxmatch

A lightweight social networking web app for adults (18+). Built to be simple to
self-host on a single VPS: no external database or storage service required.

## Features

- **Sign up / log in** with an 18+ age confirmation. Passwords are hashed
  (bcrypt); sessions use a signed httpOnly JWT cookie.
- **Profiles** — created *after* signup. Each profile has a display picture,
  a bio, and a **photo gallery**. Profile images are stored on the server.
- **Real-time 1:1 chat** over WebSockets (Socket.IO). Text history is saved so
  conversations persist across sessions.
- **File sharing in chat** — files are **relayed live and never stored** on the
  server (not on disk, not in the database). If the recipient is offline the
  file is simply not delivered. Only text messages are persisted.
- **Browse & search** other users.

## Tech

Node.js · Express · Socket.IO · SQLite (better-sqlite3) · vanilla JS frontend.

## Project layout

```
server.js              app entry (Express + Socket.IO)
src/
  config.js            env-driven config
  db.js                SQLite schema
  auth.js              JWT cookie auth helpers
  upload.js            multer image uploads (profile/gallery only)
  socket.js            live chat + ephemeral file relay
  routes/              auth, profile, users REST endpoints
public/                static SPA (HTML/CSS/JS)
deploy/                systemd unit + nginx example
data/                  SQLite DB   (gitignored, created at runtime)
uploads/               profile & gallery images (gitignored)
```

## Run locally

```bash
npm install
cp .env.example .env        # then edit JWT_SECRET
npm start
```

Open http://localhost:3000

## Deploy on your VPS (pull from GitHub)

Assumes Ubuntu/Debian with Node.js 18+ installed.

```bash
# 1. Get the code
sudo mkdir -p /var/www && cd /var/www
sudo git clone https://github.com/startfunprojects-star/getxmatch.git
cd getxmatch

# 2. Install production dependencies
sudo npm ci --omit=dev        # (or: npm install --omit=dev)

# 3. Configure
sudo cp .env.example .env
# Generate a strong secret and paste it into .env as JWT_SECRET:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# Set NODE_ENV=production in .env

# 4. Run as a service
sudo cp deploy/getxmatch.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now getxmatch
sudo systemctl status getxmatch

# 5. Reverse proxy + HTTPS (recommended)
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/getxmatch
sudo ln -s /etc/nginx/sites-available/getxmatch /etc/nginx/sites-enabled/
# edit the server_name, then:
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d your-domain.com
```

> `NODE_ENV=production` enables secure cookies, which require HTTPS. Terminate
> TLS at nginx (step 5) before switching to production.

### Updating to a new version

```bash
cd /var/www/getxmatch
sudo git pull
sudo npm ci --omit=dev
sudo systemctl restart getxmatch
```

## Configuration (.env)

| Variable          | Purpose                                             |
|-------------------|-----------------------------------------------------|
| `PORT`            | Port the app listens on (default 3000)              |
| `JWT_SECRET`      | Secret for signing auth cookies — **required** in prod |
| `NODE_ENV`        | `production` enables secure cookies                 |
| `MAX_UPLOAD_MB`   | Max profile/gallery image size (default 5)          |
| `MAX_CHAT_FILE_MB`| Max live chat file size (default 15)                |

## Notes & next steps

This is a compact foundation. If you take it toward real production traffic,
consider: email verification, password reset, content moderation/reporting,
blocking users, and a backup strategy for `data/` and `uploads/`.
