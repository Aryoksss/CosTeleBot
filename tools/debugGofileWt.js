'use strict';
// Diagnostik: dump perilaku generateWT() dari wt.obf.js. Jalankan di VPS.
const axios = require('axios');
const vm = require('vm');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function buildSandbox() {
  const noop = new Proxy(function () {}, { get: () => noop, apply: () => undefined, construct: () => ({}) });
  const readyHandlers = [];
  const base = {
    appdata: {}, console: { log: () => {}, warn: () => {}, error: () => {} },
    navigator: { userAgent: UA, platform: 'Win32', language: 'en-US' },
    location: { href: 'https://gofile.io/', hostname: 'gofile.io', protocol: 'https:', pathname: '/', host: 'gofile.io' },
    parseInt, parseFloat, String, Number, Array, Object, JSON, Math, Date, RegExp, Boolean, isNaN,
    encodeURIComponent, decodeURIComponent,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    setTimeout: () => 0, setInterval: () => 0, clearTimeout: () => {}, clearInterval: () => {},
    document: {
      addEventListener: (e, cb) => { if (e === 'DOMContentLoaded') readyHandlers.push(cb); },
      querySelector: () => null, querySelectorAll: () => [], cookie: '', readyState: 'complete',
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, getContext: () => null }),
      getElementById: () => null, body: {}, head: {},
    },
  };
  const host = new Proxy(base, {
    has: () => true,
    get(t, k) {
      if (k in t) return t[k];
      if (['window', 'self', 'globalThis', 'top', 'parent'].includes(k)) return host;
      return noop;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  base.window = host; base.self = host; base.globalThis = host;
  return { base, host, readyHandlers };
}

function getProxyAgent() {
  const raw = process.env.GOFILE_PROXY || process.env.HTTPS_PROXY || '';
  if (!raw) return null;
  try {
    if (/^socks/i.test(raw)) { const { SocksProxyAgent } = require('socks-proxy-agent'); return new SocksProxyAgent(raw); }
    const { HttpsProxyAgent } = require('https-proxy-agent'); return new HttpsProxyAgent(raw);
  } catch (e) { console.log('proxy err', e.message); return null; }
}

async function main() {
  const agent = getProxyAgent();
  console.log('proxy:', process.env.GOFILE_PROXY || process.env.HTTPS_PROXY || 'none');
  const cfg = { headers: { 'User-Agent': UA, 'Referer': 'https://gofile.io/' }, timeout: 25000, validateStatus: () => true };
  if (agent) { cfg.httpAgent = agent; cfg.httpsAgent = agent; }
  const res = await axios.get('https://gofile.io/dist/js/wt.obf.js', cfg);
  console.log('fetch wt.obf.js:', res.status, 'len', String(res.data).length);
  if (res.status !== 200) return;
  const code = String(res.data);

  const { base, host, readyHandlers } = buildSandbox();
  try { vm.createContext(host); vm.runInContext(code, host, { timeout: 5000 }); }
  catch (e) { console.log('vm run err:', e.message); }
  for (const cb of readyHandlers) { try { cb({}); } catch (e) { console.log('ready err', e.message); } }

  const funcs = Object.keys(base).filter(k => typeof base[k] === 'function');
  console.log('global funcs:', funcs);
  console.log('typeof generateWT:', typeof base.generateWT);

  if (typeof base.generateWT === 'function') {
    for (const args of [[], ['YoltD4'], ['https://gofile.io/d/YoltD4'], [Date.now()]]) {
      try {
        const v = base.generateWT(...args);
        console.log(`generateWT(${JSON.stringify(args)}) =>`, typeof v, JSON.stringify(v), '(len', String(v).length + ')');
      } catch (e) { console.log(`generateWT(${JSON.stringify(args)}) threw:`, e.message); }
    }
  }
  console.log('appdata keys:', Object.keys(base.appdata), 'appdata.wt:', base.appdata.wt);
}
main().catch(e => console.error('ERR', e.message));
