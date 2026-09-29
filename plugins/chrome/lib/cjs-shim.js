// Lets the shared CommonJS core (lib/hub.js, copied from packages/core) load as
// a plain script: it assigns module.exports, which the panel then reads.
window.module = { exports: {} }
window.exports = window.module.exports
