// CommonJS so both runtime TS code and the Expo config plugin (plain Node)
// can consume a single source of truth for the WKAppBoundDomains list.
const APP_BOUND_DOMAINS = Object.freeze([
  '3ook.com',
  'magic.link',
  'walletconnect.com',
  'youtube.com',
]);

function isAppBoundHost(host) {
  const lowerHost = host.toLowerCase();
  return APP_BOUND_DOMAINS.some(
    (domain) => lowerHost === domain || lowerHost.endsWith(`.${domain}`)
  );
}

module.exports = { APP_BOUND_DOMAINS, isAppBoundHost };
