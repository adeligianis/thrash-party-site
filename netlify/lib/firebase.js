// Shared firebase-admin setup for the Netlify Functions. Lives outside
// netlify/functions/ so Netlify doesn't deploy it as a function of its own.
'use strict';

const { initializeApp, cert, getApps, getApp } = require('firebase-admin/app');

function serviceAccount() {
  return {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    // Netlify stores the key on one line with literal \n sequences.
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  };
}

// Started on first use, so requests that are rejected early never touch Firebase.
function firebaseApp() {
  if (getApps().length) return getApp();
  return initializeApp({ credential: cert(serviceAccount()) });
}

module.exports = { firebaseApp, serviceAccount };
