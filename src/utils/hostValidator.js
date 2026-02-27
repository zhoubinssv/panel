const net = require('net');

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)(?:[a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,63}$/;

function isValidHost(host) {
  if (typeof host !== 'string') return false;
  const h = host.trim();
  return net.isIP(h) !== 0 || DOMAIN_RE.test(h);
}

module.exports = { isValidHost, DOMAIN_RE };
