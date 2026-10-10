'use strict';

// Factory agent proxy untuk axios. Mendukung http(s):// dan socks5://.
// precedence = daftar nama env yang dicek berurutan; env pertama yang terisi dipakai.
// Mengembalikan null kalau tak ada env terisi atau modul agent gagal dimuat.
function createProxyAgent(precedence, { cache = false } = {}) {
  let cached = false;
  let cachedValue = null;

  return function getProxyAgent() {
    if (cache && cached) return cachedValue;
    let agent = null;
    const raw = precedence.map((k) => process.env[k]).find((v) => v && String(v).trim());
    if (raw) {
      try {
        const url = String(raw).trim();
        if (url.startsWith('socks')) {
          const { SocksProxyAgent } = require('socks-proxy-agent');
          agent = new SocksProxyAgent(url);
        } else {
          const { HttpsProxyAgent } = require('https-proxy-agent');
          agent = new HttpsProxyAgent(url);
        }
      } catch (_) {
        agent = null;
      }
    }
    if (cache) {
      cached = true;
      cachedValue = agent;
    }
    return agent;
  };
}

module.exports = { createProxyAgent };
