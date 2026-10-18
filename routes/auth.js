const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const authRequired = require('../middleware/auth');
const { signToken } = require('../utils/jwt');
const { UPLOADS_ROOT } = require('../utils/files');

const router = express.Router();

// Provider configs. Secrets live server-side; the app only ever sees the
// backend's own JWT. Set BASE_URL to the publicly reachable backend origin.
const PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    profile: (p) => ({ subject: p.sub, email: p.email, name: p.name ?? p.email, avatar: p.picture }),
  },
  microsoft: {
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    userinfoUrl: 'https://graph.microsoft.com/oidc/userinfo',
    scope: 'openid email profile offline_access User.Read',
    clientId: () => process.env.MICROSOFT_CLIENT_ID,
    clientSecret: () => process.env.MICROSOFT_CLIENT_SECRET,
    profile: (p) => ({ subject: p.sub, email: p.email, name: p.name ?? p.email, avatar: null }),
  },
};

// Deep-link schemes the mobile app may ask to be returned to.
const ALLOWED_RETURN = /^(tressurer|mobile|exp|https?):\//;

const encodeState = (payload) =>
  Buffer.from(JSON.stringify(payload)).toString('base64url');
const decodeState = (state) => {
  try {
    return JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

const callbackUri = (provider) => `${process.env.BASE_URL}/api/auth/${provider}/callback`;

// Microsoft OIDC userinfo has no picture — pull the Graph photo during the
// callback and store it locally; served via GET /api/avatars/:file.
const saveMsAvatar = async (accessToken, userId) => {
  try {
    const r = await fetch('https://graph.microsoft.com/v1.0/me/photos/240x240/$value', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    const dir = path.join(UPLOADS_ROOT, 'avatars');
    await fs.promises.mkdir(dir, { recursive: true });
    const file = `${userId}.jpg`;
    await fs.promises.writeFile(path.join(dir, file), Buffer.from(await r.arrayBuffer()));
    return `/api/avatars/${file}`;
  } catch {
    return null;
  }
};

// GET /api/auth/:provider?redirect_uri=<app deep link>
// Kicks off the OAuth dance; the app deep link rides along in `state`.
router.get('/:provider', (req, res) => {
  const provider = PROVIDERS[req.params.provider];
  if (!provider) {
    return res.status(404).json({ error: 'Unknown provider' });
  }
  const appRedirect = req.query.redirect_uri;

  if (!provider.clientId()) {
    return res.status(501).json({ error: `${req.params.provider} OAuth is not configured` });
  }
  if (!appRedirect || !ALLOWED_RETURN.test(appRedirect)) {
    return res.status(400).json({ error: 'Invalid redirect_uri' });
  }

  const state = encodeState({ r: appRedirect, n: crypto.randomUUID() });
  const url = new URL(provider.authUrl);
  url.search = new URLSearchParams({
    client_id: provider.clientId(),
    redirect_uri: callbackUri(req.params.provider),
    response_type: 'code',
    scope: provider.scope,
    state,
  }).toString();

  res.redirect(url.toString());
});

// GET /api/auth/:provider/callback?code=…&state=…
// Exchanges the code, upserts the user, then 302s back to the app deep link
// with ?token=<jwt>&user=<url-encoded-json> — what the mobile app parses.
router.get('/:provider/callback', async (req, res, next) => {
  const provider = PROVIDERS[req.params.provider];
  if (!provider) {
    return res.status(404).json({ error: 'Unknown provider' });
  }
  const state = decodeState(req.query.state || '');
  const appRedirect = state?.r;

  const fail = (msg) =>
    appRedirect && ALLOWED_RETURN.test(appRedirect)
      ? res.redirect(`${appRedirect}?error=${encodeURIComponent(msg)}`)
      : res.status(400).json({ error: msg });

  try {
    if (!appRedirect || !ALLOWED_RETURN.test(appRedirect)) {
      return res.status(400).json({ error: 'Invalid state' });
    }
    if (req.query.error) {
      return fail(req.query.error_description || req.query.error);
    }
    if (!req.query.code) {
      return fail('Missing authorization code');
    }

    // authorization_code → tokens
    const tokenRes = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: req.query.code,
        redirect_uri: callbackUri(req.params.provider),
        client_id: provider.clientId(),
        client_secret: provider.clientSecret(),
      }),
    });
    if (!tokenRes.ok) return fail('Token exchange failed');
    const tokens = await tokenRes.json();

    // access_token → profile
    const profileRes = await fetch(provider.userinfoUrl, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!profileRes.ok) return fail('Failed to fetch profile');
    const profile = provider.profile(await profileRes.json());
    if (!profile.email) return fail('Provider returned no email');

    // Upsert the user keyed on (provider, subject)
    const { rows } = await db.query(
      `INSERT INTO users (email, name, avatar_url, provider, provider_subject)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider, provider_subject)
       DO UPDATE SET name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url
       RETURNING id, email, name, avatar_url`,
      [profile.email, profile.name, profile.avatar, req.params.provider, profile.subject]
    );
    const user = rows[0];

    // Microsoft gives no picture in userinfo — save the Graph photo now.
    if (req.params.provider === 'microsoft') {
      const avatar = await saveMsAvatar(tokens.access_token, user.id);
      if (avatar) {
        await db.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [avatar, user.id]);
        user.avatar_url = avatar;
      }
    }

    const token = signToken(user);
    const userParam = encodeURIComponent(
      JSON.stringify({ id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url })
    );
    res.redirect(`${appRedirect}?token=${encodeURIComponent(token)}&user=${userParam}`);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/auth/me  { name }
// Profile management: only the display name is editable — email and avatar
// are owned by the OAuth provider and re-sync on every login.
router.patch('/me', authRequired, async (req, res, next) => {
  try {
    const name = (req.body?.name ?? '').trim();
    if (!name || name.length > 120) {
      return res.status(400).json({ error: 'Name must be 1–120 characters' });
    }
    const { rows } = await db.query(
      `UPDATE users SET name = $1 WHERE id = $2
       RETURNING id, email, name, avatar_url`,
      [name, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
