# getxmatch

A lightweight social networking web app for adults (18+). Built to be simple to
self-host on a single VPS: no external database or storage service required.

## Features

- **Sign up / log in** with an 18+ age confirmation and **email OTP
  verification** — a 6-digit code is emailed on signup and the account is only
  created once the code is entered. Passwords are hashed (bcrypt); sessions use
  a signed httpOnly JWT cookie.
- **Admin dashboard** at `/admin` — lists every user with a live green
  online/offline indicator, lets the admin create users **without** an email
  address (username + password), and delete users. The admin password is set
  and reset only via a **single-use link emailed to `ADMIN_EMAIL`**; each new
  request invalidates the previous link.
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

## Deploy with Docker (recommended)

The repo ships a `Dockerfile` and `docker-compose.yml`. The image is based on
Node 24 (SQLite built in — no native build). The SQLite database and profile/
gallery images are kept in named volumes so they survive restarts and rebuilds.
Chat-shared files are never written to disk, so nothing about them is persisted.

On your VPS:

```bash
# 1. Get the code
git clone https://github.com/startfunprojects-star/getxmatch.git
cd getxmatch

# 2. Create a .env with a strong secret (used by docker-compose)
echo "JWT_SECRET=$(openssl rand -hex 48)" > .env

# 3. Build and run
docker compose up -d --build

# Check it
docker compose ps
docker compose logs -f app
```

The app is now on port 3000. Manage it with:

```bash
docker compose restart app      # restart
docker compose down             # stop (volumes are kept)
docker compose up -d --build    # apply an update after `git pull`
```

### Updating

```bash
git pull
docker compose up -d --build
```

### HTTPS

Run a reverse proxy in front for TLS and WebSocket upgrade — either use the
`deploy/nginx.conf.example` on the host, or point an existing Caddy/Traefik/nginx
container at `http://getxmatch:3000`. `NODE_ENV=production` sets secure cookies,
which require the app to be reached over HTTPS.

## Deploy on your VPS without Docker (pull from GitHub)

Assumes Ubuntu/Debian with **Node.js 24+** installed (for built-in SQLite).

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
| `PUBLIC_URL`      | Public base URL, used for links inside emails (e.g. `https://getxmatch.com`) |
| `ADMIN_EMAIL`     | Where the admin set/reset link is sent (default `gauravsharma.ps@gmail.com`) |
| `OTP_TTL_MIN`     | Signup OTP lifetime in minutes (default 10)         |
| `OTP_MAX_ATTEMPTS`| Wrong-code attempts before the OTP is discarded (default 5) |
| `ADMIN_RESET_TTL_MIN` | Admin reset-link lifetime in minutes (default 60) |
| `SMTP_HOST`       | SMTP server (default `smtp.hostinger.com`)          |
| `SMTP_PORT`       | SMTP port (default 465)                             |
| `SMTP_SECURE`     | `true` for port 465, `false` for 587 (default true) |
| `SMTP_USER`       | SMTP mailbox login. **If blank, OTPs/links are printed to the server log instead of emailed.** |
| `SMTP_PASS`       | SMTP mailbox password                               |
| `MAIL_FROM`       | `From:` header, e.g. `getxmatch <no-reply@getxmatch.com>` |

### Email & the admin account

Both the signup OTP and the admin set/reset link are sent over SMTP. **Until
`SMTP_USER`/`SMTP_PASS` are set, the app does not send real email — it prints the
message (OTP code / reset link) to the server log** (`journalctl -u getxmatch`),
which is handy for testing.

To set the **first admin password**: go to `/admin`, click *"Email me a
set-password link"*, then open the link that arrives at `ADMIN_EMAIL` (or, before
SMTP is configured, copy it from the server log) and choose a password. Requesting
a new link at any time invalidates the previous one.

## Notes & next steps

This is a compact foundation. If you take it toward real production traffic,
consider: email verification, password reset, content moderation/reporting,
blocking users, and a backup strategy for `data/` and `uploads/`.
