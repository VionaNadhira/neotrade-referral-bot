const axios = require("axios");
const { ethers } = require("ethers");

const DEFAULT_BASE = "https://app.neotrade.pro";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(tag, msg) {
  if (process.env.VERBOSE === "1") {
    console.log("    [" + tag + "] " + msg);
  }
}

// ============================================================
// MINIMAL COOKIE JAR
// neotrade.pro uses httpOnly cookies (credentials: same-origin).
// We accumulate name=value pairs from Set-Cookie and replay them
// as a Cookie header on subsequent requests in the same session.
// ============================================================

class CookieJar {
  constructor() {
    this.cookies = {};
  }
  capture(setCookie) {
    if (!setCookie) return;
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const raw of list) {
      if (!raw) continue;
      const pair = raw.split(";")[0]; // "name=value"
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name) this.cookies[name] = value;
    }
  }
  header() {
    return Object.keys(this.cookies)
      .map((k) => k + "=" + this.cookies[k])
      .join("; ");
  }
  has(name) {
    return Object.prototype.hasOwnProperty.call(this.cookies, name);
  }
}

// ============================================================
// REQUEST CLIENT per session (one jar per wallet)
// ============================================================

function makeClient(baseUrl, jar) {
  const base = (baseUrl || DEFAULT_BASE).replace(/\/$/, "");
  const instance = axios.create({
    baseURL: base,
    timeout: 30000,
    validateStatus: () => true, // we handle status ourselves
    maxRedirects: 0,
  });

  async function request(method, urlPath, body) {
    const headers = {
      Origin: base,
      Referer: base + "/",
      "Accept": "application/json, text/plain, */*",
    };
    const cookie = jar.header();
    if (cookie) headers["Cookie"] = cookie;

    let res;
    if (method === "GET") {
      res = await instance.get(urlPath, { headers });
    } else {
      headers["Content-Type"] = "application/json";
      res = await instance.post(urlPath, body, { headers });
    }

    // capture any set-cookie from this response
    jar.capture(res.headers && res.headers["set-cookie"]);

    return {
      status: res.status,
      data: res.data,
      headers: res.headers,
    };
  }

  return { request, base };
}

// ============================================================
// AUTH: SIWE (Sign-In with Ethereum)
// ============================================================

// POST /v1/auth/siwe/challenge {address} -> { nonce, message }
async function siweChallenge(client, address) {
  const res = await client.request("POST", "/v1/auth/siwe/challenge", { address });
  if (res.status >= 400) {
    return { success: false, error: "challenge HTTP " + res.status + ": " + JSON.stringify(res.data) };
  }
  const data = res.data || {};
  if (!data.nonce || !data.message) {
    return { success: false, error: "challenge missing nonce/message: " + JSON.stringify(data) };
  }
  log("siwe", "challenge nonce=" + String(data.nonce).slice(0, 12) + "... message_len=" + String(data.message).length);
  return { success: true, nonce: data.nonce, message: data.message };
}

// POST /v1/auth/siwe/verify {nonce, signature, invite_code?} -> sets auth cookie, returns account
async function siweVerify(client, nonce, signature, inviteCode) {
  const body = { nonce, signature };
  if (inviteCode) body.invite_code = inviteCode;
  const res = await client.request("POST", "/v1/auth/siwe/verify", body);
  if (res.status >= 400) {
    return { success: false, error: "verify HTTP " + res.status + ": " + JSON.stringify(res.data) };
  }
  log("siwe", "verify OK status=" + res.status);
  return { success: true, data: res.data || {} };
}

// Full SIWE login flow for one ethers wallet.
// 1) challenge  2) personal_sign the message  3) verify with invite_code
async function siweLogin(ethersWallet, inviteCode, baseUrl) {
  const jar = new CookieJar();
  const client = makeClient(baseUrl, jar);
  const address = await ethersWallet.getAddress();

  log("siwe", "address=" + address);

  const ch = await siweChallenge(client, address);
  if (!ch.success) return { success: false, error: ch.error, jar, client };

  // personal_sign = EIP-191. ethers signMessage applies the prefix automatically.
  const signature = await ethersWallet.signMessage(ch.message);
  log("siwe", "signature=" + signature.slice(0, 10) + "..." + signature.slice(-6));

  const vf = await siweVerify(client, ch.nonce, signature, inviteCode);
  if (!vf.success) return { success: false, error: vf.error, jar, client };

  return { success: true, account: vf.data, jar, client };
}

// ============================================================
// AUTH: EMAIL (optional alternative login with invite_code)
// ============================================================

async function emailStart(client, email) {
  const res = await client.request("POST", "/v1/auth/email/start", { email });
  if (res.status >= 400) {
    return { success: false, error: "email/start HTTP " + res.status + ": " + JSON.stringify(res.data) };
  }
  return { success: true, data: res.data };
}

async function emailVerify(client, email, code, inviteCode) {
  const body = { email, code };
  if (inviteCode) body.invite_code = inviteCode;
  const res = await client.request("POST", "/v1/auth/email/verify", body);
  if (res.status >= 400) {
    return { success: false, error: "email/verify HTTP " + res.status + ": " + JSON.stringify(res.data) };
  }
  return { success: true, data: res.data || {} };
}

// ============================================================
// WALLET BIND (attach a wallet to an existing email-authed account)
// ============================================================

async function walletChallenge(client, address) {
  const res = await client.request("POST", "/v1/wallet/challenge", { address });
  if (res.status >= 400) {
    return { success: false, error: "wallet/challenge HTTP " + res.status + ": " + JSON.stringify(res.data) };
  }
  const data = res.data || {};
  if (!data.nonce || !data.message) {
    return { success: false, error: "wallet/challenge missing nonce/message: " + JSON.stringify(data) };
  }
  return { success: true, nonce: data.nonce, message: data.message };
}

async function walletBind(client, ethersWallet, baseUrl) {
  const address = await ethersWallet.getAddress();
  const ch = await walletChallenge(client, address);
  if (!ch.success) return { success: false, error: ch.error };
  const signature = await ethersWallet.signMessage(ch.message);
  const res = await client.request("POST", "/v1/wallet/bind", { nonce: ch.nonce, signature });
  if (res.status >= 400) {
    return { success: false, error: "wallet/bind HTTP " + res.status + ": " + JSON.stringify(res.data) };
  }
  return { success: true, data: res.data };
}

// ============================================================
// ACCOUNT / REFERRAL INFO
// ============================================================

// GET /v1/me -> current user/account
async function getMe(client) {
  const res = await client.request("GET", "/v1/me");
  if (res.status >= 400) {
    return { success: false, error: "me HTTP " + res.status + ": " + JSON.stringify(res.data) };
  }
  return { success: true, data: res.data };
}

// GET /v1/invite-codes?status=&page=&tx_hash= -> referral codes + mint status
async function getInviteCodes(client, opts) {
  opts = opts || {};
  const params = new URLSearchParams();
  if (opts.status) params.set("status", String(opts.status));
  if (opts.page) params.set("page", String(opts.page));
  if (opts.tx_hash) params.set("tx_hash", String(opts.tx_hash));
  const qs = params.toString();
  const res = await client.request("GET", "/v1/invite-codes" + (qs ? "?" + qs : ""));
  if (res.status >= 400) {
    return { success: false, error: "invite-codes HTTP " + res.status + ": " + JSON.stringify(res.data) };
  }
  return { success: true, data: res.data };
}

// POST /v1/invite-codes/:id/retry -> retry a failed code mint
async function retryInviteCode(client, id) {
  const res = await client.request("POST", "/v1/invite-codes/" + encodeURIComponent(id) + "/retry", {});
  if (res.status >= 400) {
    return { success: false, error: "retry HTTP " + res.status + ": " + JSON.stringify(res.data) };
  }
  return { success: true, data: res.data };
}

// POST /v1/auth/logout
async function logout(client) {
  try {
    await client.request("POST", "/v1/auth/logout", {});
  } catch (e) {}
  return { success: true };
}

module.exports = {
  CookieJar,
  makeClient,
  siweChallenge,
  siweVerify,
  siweLogin,
  emailStart,
  emailVerify,
  walletBind,
  getMe,
  getInviteCodes,
  retryInviteCode,
  logout,
  sleep,
};
