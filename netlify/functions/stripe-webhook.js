// Receives Stripe webhooks and records song requests in Firestore.
// Each request is stored at requests/{checkout session id}; that id is
// stable across Stripe's retries, so repeat deliveries are no-ops.
'use strict';

const Stripe = require('stripe');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { firebaseApp } = require('../lib/firebase');
const SONGS = require('../../requests/songs.json');

// Keys of the custom fields set up on the Stripe payment links.
const SONG_FIELD_KEY = 'song';
const SHOUTOUT_FIELD_KEY = 'shoutout';

// Firestore error code for create() on a document that already exists.
const ALREADY_EXISTS = 6;

// Must match slug() and payUrl() in src/pages/requests/index.html, which build
// the client_reference_id sent to Stripe.
const slug = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/['’.!?,()]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const SONG_BY_REF = new Map(
  SONGS.map(([title, artist]) => [`${slug(title)}_${slug(artist)}`.slice(0, 200), `${title}, ${artist}`])
);

const firestore = () => getFirestore(firebaseApp());

const reply = (statusCode, body) => ({ statusCode, body });

function customField(session, key) {
  const field = (session.custom_fields || []).find((f) => f.key === key);
  if (!field) return null;
  const value = field.text?.value ?? field.dropdown?.value ?? field.numeric?.value;
  const trimmed = value == null ? '' : String(value).trim();
  return trimmed || null;
}

// Only the first word of the name Checkout collected (name on card, or from
// Apple Pay / Google Pay), so the stage screen can say who asked. Card names
// often arrive in capitals, so those are tidied to "Sam".
function firstName(session) {
  const word = String(session.customer_details?.name || '').trim().split(/\s+/)[0] || '';
  if (!word) return null;
  const tidy = word === word.toUpperCase() ? word[0] + word.slice(1).toLowerCase() : word;
  return tidy.slice(0, 30);
}

function kindOf(session) {
  const link = session.payment_link;
  if (link && link === process.env.STRIPE_TIP_LINK_ID) return 'tip';
  if (link && link === process.env.STRIPE_FREEBIRD_LINK_ID) return 'freebird';
  return 'request';
}

// Returns a short note for the response body, which Stripe shows on the
// event's delivery page.
async function recordCheckout(session, paidAt) {
  if (session.payment_status !== 'paid') return `skipped: payment_status is ${session.payment_status}`;

  const songTyped = customField(session, SONG_FIELD_KEY);
  const songTapped = session.client_reference_id || null;
  const paymentIntentId = typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent?.id ?? null;

  const request = {
    amountCents: session.amount_total,
    // When the payment went through, not when checkout was opened, so a fan
    // who opened checkout before the show started still lands in that show.
    createdAt: Timestamp.fromMillis(paidAt * 1000),
    paymentIntentId,
    songTyped,
    shoutout: customField(session, SHOUTOUT_FIELD_KEY),
    firstName: firstName(session),
    songTapped,
    song: songTyped || (songTapped && SONG_BY_REF.get(songTapped)) || null,
    kind: kindOf(session),
    status: 'new',
    refunded: false,
  };

  try {
    // create() rather than set(): a repeat delivery must not reset fields the
    // band has changed since (status, refunded).
    await firestore().collection('requests').doc(session.id).create(request);
  } catch (err) {
    if (err.code !== ALREADY_EXISTS) throw err;
    return `already saved: ${session.id}`;
  }
  return `saved ${request.kind} ${request.amountCents}c as requests/${session.id}`;
}

async function recordRefund(charge) {
  const paymentIntentId = typeof charge.payment_intent === 'string'
    ? charge.payment_intent
    : charge.payment_intent?.id;
  if (!paymentIntentId) return false;

  const matches = await firestore().collection('requests')
    .where('paymentIntentId', '==', paymentIntentId).get();
  // update() to the same value is harmless, so repeats are fine here too.
  await Promise.all(matches.docs.map((doc) => doc.ref.update({ refunded: true })));
  return !matches.empty;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, 'Method not allowed');

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('stripe-webhook: STRIPE_WEBHOOK_SECRET is not set');
    return reply(500, 'Not configured');
  }

  // The signature covers the exact bytes Stripe sent, so verify the raw body.
  const rawBody = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8');
  const signature = event.headers['stripe-signature'];

  let stripeEvent;
  try {
    stripeEvent = Stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    console.error(`stripe-webhook: signature check failed: ${err.message.split("\n")[0]}`);
    return reply(400, 'Invalid signature');
  }

  let note = `ignored: ${stripeEvent.type}`;
  try {
    if (stripeEvent.type === 'checkout.session.completed') {
      note = await recordCheckout(stripeEvent.data.object, stripeEvent.created ?? stripeEvent.data.object.created);
    } else if (stripeEvent.type === 'charge.refunded') {
      const found = await recordRefund(stripeEvent.data.object);
      if (!found) console.warn(`stripe-webhook: ${stripeEvent.id} refund matches no saved request`);
      note = found ? 'marked refunded' : 'refund matches no saved request';
    }
  } catch (err) {
    // Only the event id and error, never customer details. A non-2xx makes
    // Stripe retry later, which is safe because the writes are idempotent.
    console.error(`stripe-webhook: ${stripeEvent.id} (${stripeEvent.type}) failed: ${err.message}`);
    return reply(500, 'Error');
  }

  console.log(`stripe-webhook: ${stripeEvent.id} ${note}`);
  return reply(200, note);
};
