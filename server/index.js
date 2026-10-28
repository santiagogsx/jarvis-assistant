// Run Jarvis without the desktop window: `npm run server`.
// Handy for an always-on PC or a cloud host. On a cloud host, set keys with
// environment variables (OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY,
// GEMINI_API_KEY, JARVIS_PROVIDER, JARVIS_MODEL, JARVIS_PASSCODE, PORT, ...).
const path = require('path');
const { createStore } = require('./store');
const { startServer } = require('./app');

const dataDir = process.env.JARVIS_DATA || path.join(__dirname, '..', 'data');
const store = createStore(dataDir);

startServer({
  store,
  port: Number(process.env.PORT) || undefined,
  host: process.env.HOST || (process.env.PORT ? '0.0.0.0' : undefined),
}).then(srv => {
  console.log(`\n  J.A.R.V.I.S. online at http://localhost:${srv.port}`);
  const urls = srv.lanUrls();
  if (store.get().remote.enabled && urls.length) console.log(`  Phones on this Wi-Fi: ${urls.join('  ')}`);
  console.log('');
}).catch(e => {
  console.error('Jarvis could not start:', e.message);
  process.exit(1);
});
