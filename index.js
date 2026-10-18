require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const multer = require('multer');
const path = require('path');
const { UPLOADS_ROOT } = require('./utils/files');

const authRoutes = require('./routes/auth');
const workspaceRoutes = require('./routes/workspaces');
const transactionRoutes = require('./routes/transactions');
const approvalRoutes = require('./routes/approvals');
const reportRoutes = require('./routes/reports');
const fileRoutes = require('./routes/files');
const trashRoutes = require('./routes/trash');
const emailRoutes = require('./routes/email');
const { purgeExpired } = require('./utils/trash');

const app = express();
const PORT = process.env.PORT || 5000;

// Behind nginx on the VPS — trust the first hop for correct client IPs.
app.set('trust proxy', 1);

// RN's OkHttp layer caches GETs and sends If-None-Match; a 304 lands in axios's
// error path with an empty body, which the app reads as "workspace gone".
// Fresh JSON every time instead.
app.disable('etag');

app.use(helmet());

// CORS — only browsers send Origin and enforce this. Native app traffic,
// curl and server-to-server calls carry no Origin header and always pass.
// Allowed browser origins come from CORS_ORIGINS (comma-separated); localhost
// is always allowed for dev (Expo web on :8081 etc.).
const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || corsOrigins.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return cb(null, true);
      }
      return cb(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: false,
  })
);
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Provider profile photos saved server-side (Microsoft Graph has no public
// URL). UUID filenames are unguessable; public like a Gravatar.
const AVATARS_DIR = path.join(UPLOADS_ROOT, 'avatars');
app.get('/api/avatars/:file', (req, res) => {
  if (!/^[A-Za-z0-9-]+\.(jpe?g|png|webp)$/i.test(req.params.file)) {
    return res.status(404).end();
  }
  res.sendFile(path.join(AVATARS_DIR, req.params.file));
});

app.use('/api/auth', authRoutes);
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/workspaces', transactionRoutes);
app.use('/api/workspaces', approvalRoutes);
app.use('/api/workspaces', reportRoutes);
app.use('/api/workspaces', fileRoutes);
app.use('/api/workspaces', trashRoutes);
app.use('/api/workspaces', emailRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: err.message });
  }
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// Trash hygiene: purge rows past their 30-day expiry once a day (and on boot).
purgeExpired().catch(() => {});
setInterval(() => purgeExpired().catch(() => {}), 24 * 60 * 60 * 1000).unref();
