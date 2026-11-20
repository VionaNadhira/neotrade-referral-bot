// ============================================================
// MANUAL BROWSER MODE (optional)
// neotrade.pro has NO captcha, so the primary bot flow is pure-API
// (see api.js). This module opens a REAL (non-headless) browser to
// the invite URL so you can sign up interactively with your own
// wallet (Reown AppKit / WalletConnect), then captures the session
// cookie + account so the result is tracked like an auto run.
//
// puppeteer is an optionalDependency: install it only if you want
// manual mode. Auto mode never touches a browser.
// ============================================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync, spawn } = require("child_process");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let puppeteer = null;
function loadPuppeteer() {
  if (puppeteer) return puppeteer;
  try {
    puppeteer = require("puppeteer-extra");
    try {
      const StealthPlugin = require("puppeteer-extra-plugin-stealth");
      puppeteer.use(StealthPlugin());
    } catch (e) {}
  } catch (e) {
    throw new Error(
      "puppeteer tidak terpasang. Jalankan: npm install puppeteer puppeteer-extra puppeteer-extra-plugin-stealth\n" +
        "(Hanya butuh untuk mode manual. Mode auto berjalan tanpa browser.)"
    );
  }
  return puppeteer;
}

// Locate a Chrome/Chromium binary on this machine.
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  try {
    const p = require("child_process").execSync("which google-chrome chromium chromium-browser 2>/dev/null", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split("\n")[0];
    if (p) return p;
  } catch (e) {}
  return null;
}

// Read localStorage entries that survive across reloads (the app keeps
// invite + onboarding flags here). Useful for debugging, not auth itself.
async function readLocalStorage(page) {
  try {
    return await page.evaluate(() => {
      const out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        out[k] = localStorage.getItem(k);
      }
      return out;
    });
  } catch (e) {
    return {};
  }
}

// ============================================================
// MANUAL SIGNUP — open browser, let user connect their wallet,
// wait for the auth cookie to appear, then return session info.
// ============================================================

async function openBrowserManual(walletInfo, inviteCode, baseUrl) {
  const pptr = loadPuppeteer();
  const chromeBin = findChrome();
  if (!chromeBin) throw new Error("Chrome/Chromium tidak ditemukan. Set CHROME_PATH atau install google-chrome.");

  const base = (baseUrl || "https://app.neotrade.pro").replace(/\/$/, "");
  const port = 9400 + (walletInfo.index % 100);
  const userDataDir = path.join(os.tmpdir(), "neotrade-chrome-" + walletInfo.index);

  try { execSync("fuser -k " + port + "/tcp 2>/dev/null"); } catch (e) {}

  const args = [
    "--no-sandbox",
    "--remote-debugging-port=" + port,
    "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=" + userDataDir,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
  ];

  const proc = spawn(chromeBin, args, { detached: true, stdio: "ignore" });
  proc.unref();
  console.log("  [manual] Menunggu Chrome di port " + port + " ...");
  await sleep(6000);

  let browser;
  try {
    browser = await pptr.connect({ browserURL: "http://127.0.0.1:" + port, defaultViewport: null });
  } catch (e) {
    try { if (proc && proc.pid) process.kill(-proc.pid, "SIGKILL"); } catch (x) {}
    try { execSync("fuser -k " + port + "/tcp 2>/dev/null"); } catch (x) {}
    return { success: false, error: "Cannot connect to Chrome: " + e.message };
  }

  const pages = await browser.pages();
  const page = pages.length > 0 ? pages[pages.length - 1] : await browser.newPage();

  // The referral signup URL. The app reads ?invite=<CODE> and stores it.
  const inviteUrl = base + "/?invite=" + encodeURIComponent(inviteCode || "");
  console.log("  [manual] Membuka: " + inviteUrl);
  await page.goto(inviteUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});

  console.log("");
  console.log("  ─────────────────────────────────────────────────────────");
  console.log("  Langkah manual di browser yang terbuka:");
  console.log("    1. Connect wallet kamu (Reown AppKit / WalletConnect / MetaMask)");
  console.log("    2. Selesaikan sign-up / SIWE sign request");
  console.log("    3. Tunggu sampai masuk ke dashboard (URL berubah / akun terlihat)");
  console.log("    4. Kembali ke terminal ini dan tekan ENTER untuk capture sesi");
  console.log("  ─────────────────────────────────────────────────────────");
  console.log("  (Wallet HD referensi untuk index ini — untuk auto mode, bukan manual):");
  console.log("    Address    : " + walletInfo.address);
  console.log("    Private Key: " + walletInfo.privateKey);
  console.log("");

  await waitForEnter();

  // Capture cookies + localStorage after the user finished signup.
  let cookies = [];
  let localStorageData = {};
  try {
    cookies = await page.cookies();
  } catch (e) {}
  try {
    localStorageData = await readLocalStorage(page);
  } catch (e) {}

  const cookieHeader = cookies.map((c) => c.name + "=" + c.value).join("; ");
  const hasSession = cookies.some((c) => /session|token|auth|sid/i.test(c.name));

  try { await browser.close(); } catch (e) {}
  try { execSync("fuser -k " + port + "/tcp 2>/dev/null"); } catch (e) {}
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}

  return {
    success: hasSession || cookies.length > 0,
    cookieHeader: cookieHeader,
    cookies: cookies,
    localStorage: localStorageData,
    warning: hasSession ? null : "Tidak ada cookie sesi terdeteksi — pastikan signup sudah selesai.",
  };
}

function waitForEnter() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

module.exports = {
  openBrowserManual,
  loadPuppeteer,
  findChrome,
  sleep,
};
