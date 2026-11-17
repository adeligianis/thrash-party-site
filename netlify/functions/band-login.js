// Exchanges the band PIN for a Firebase custom token (uid "band", claim
// band: true). The browser signs in with signInWithCustomToken(), and the
// Firestore rules grant access based on that claim.
'use strict';

const crypto = require('crypto');
const { serviceAccount } = require('../lib/firebase');

const WRONG_PIN_DELAY_MS = 1000;
const TOKEN_AUDIENCE = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';

const reply = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Hashing first gives both sides the same length, which timingSafeEqual
// requires, so the comparison time doesn't reveal the PIN's length either.
function pinMatches(given, expected) {
  const hash = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();
  return crypto.timingSafeEqual(hash(given), hash(expected));
}

// Same token firebase-admin's createCustomToken() makes: an RS256 JWT signed
// with the service account key. Built by hand because loading
// firebase-admin/auth crashes on Netlify's function runtime (ERR_REQUIRE_ESM).
function customToken(uid, claims) {
  const { clientEmail, privateKey } = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
    iss: clientEmail, sub: clientEmail, aud: TOKEN_AUDIENCE, iat: now, exp: now + 3600, uid, claims,
  })}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
  return `${unsigned}.${signature}`;
}

function readPin(event) {
  try {
    const raw = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8').toString('utf8');
    const { pin } = JSON.parse(raw);
    return typeof pin === 'string' || typeof pin === 'number' ? String(pin) : null;
  } catch {
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });

  const expected = process.env.BAND_PIN;
  if (!expected) {
    console.error('band-login: BAND_PIN is not set');
    return reply(500, { error: 'Not configured' });
  }

  const pin = readPin(event);
  if (pin === null) return reply(400, { error: 'Send JSON like {"pin": "1234"}' });

  if (!pinMatches(pin, expected)) {
    await sleep(WRONG_PIN_DELAY_MS);
    return reply(401, { error: 'Wrong PIN' });
  }

  try {
    const token = customToken('band', { band: true });
    return reply(200, { token });
  } catch (err) {
    console.error(`band-login: could not create token: ${err.message}`);
    return reply(500, { error: 'Could not sign in' });
  }
};
