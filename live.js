// Live broadcast transport over Firebase Realtime Database's REST API.
// No SDK, no auth token: with public read/write rules, the phone PUTs the game
// JSON and viewers GET it. The DB URL is public config, safe to embed here.
//
// SETUP: paste your Realtime Database URL below (from the Firebase console),
// e.g. https://livego-xxxx-default-rtdb.firebaseio.com  (no trailing slash).
const FIREBASE_DB_URL = 'https://livego-ll-default-rtdb.firebaseio.com';

function liveConfigured() {
  return FIREBASE_DB_URL && !FIREBASE_DB_URL.startsWith('PASTE_');
}

// URL of one game's JSON node.
function liveGameUrl(id) {
  return `${FIREBASE_DB_URL}/games/${id}.json`;
}

// Publish (overwrite) a game's JSON. Returns true on success.
async function livePublish(id, game) {
  if (!liveConfigured()) return false;
  try {
    const res = await fetch(liveGameUrl(id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(game),
    });
    return res.ok;
  } catch (e) {
    console.warn('livePublish failed:', e.message);
    return false;
  }
}

// Fetch a game's JSON (viewer side). Returns the object or null.
async function liveFetch(id) {
  if (!liveConfigured()) return null;
  const res = await fetch(liveGameUrl(id) + '?ts=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.json();
}

// A short, URL-safe game id.
function liveNewGameId() {
  return Math.random().toString(36).slice(2, 8);
}
