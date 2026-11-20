require("dotenv").config();
const readline = require("readline");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const {
  deriveWallets,
  deriveOne,
  isAlreadyProcessed,
  saveProcessedWallet,
  loadProcessedWallets,
  clearProcessedWallets,
} = require("./wallet");

const {
  siweLogin,
  getMe,
  getInviteCodes,
  logout,
  CookieJar,
  makeClient,
  sleep,
} = require("./api");

const { openBrowserManual } = require("./browser");

// ============================================================
// HELPERS
// ============================================================

function askQuestion(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function short(s, n) {
  if (!s) return "";
  n = n || 10;
  return s.length > n ? s.slice(0, n) + "..." + s.slice(-4) : s;
}

function updateEnvMnemonic(mnemonic) {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, "utf8");
    envContent = envContent.replace(/^MNEMONIC=.*/m, "MNEMONIC=" + mnemonic);
    fs.writeFileSync(envPath, envContent);
  }
  process.env.MNEMONIC = mnemonic;
}

// ============================================================
// MENU
// ============================================================

async function showMenu() {
  console.log("\n\n" + "=".repeat(50));
  console.log("       neotrade.pro Referral Bot v1.0");
  console.log("       (Pure-API SIWE + invite_code, NO captcha)");
  console.log("=".repeat(50));
  console.log("\nPilih mode operasi:");
  console.log("  1) Generate New Wallet");
  console.log("  2) Run Bot Auto   (Pure-API SIWE — no browser, no captcha)");
  console.log("  3) Run Bot Manual (Buka Chrome asli, signup interaktif)");
  console.log("  4) Check Referral Status");
  console.log("  5) View Processed Wallets");
  console.log("  6) Reset Wallet Data (Hapus MNEMONIC di .env & processed_wallets.json)");
  console.log("  0) Exit\n");
}

// ============================================================
// MODE 1: Generate New Wallet
// ============================================================

async function modeGenerateWallet() {
  const count = parseInt(process.env.MAX_INDEX || "50");

  const newWallet = ethers.Wallet.createRandom();
  const mnemonic = newWallet.mnemonic.phrase;
  const hdNode = ethers.HDNodeWallet.fromMnemonic(newWallet.mnemonic, "m/44'/60'/0'/0");

  updateEnvMnemonic(mnemonic);

  console.log("\n" + "=".repeat(60));
  console.log("  WALLET BARU TELAH DIBUAT & DISIMPAN KE .env!");
  console.log("=".repeat(60));
  console.log("  Mnemonic : " + mnemonic);
  console.log("  Total    : " + count + " wallet (sesuai MAX_INDEX di .env)");
  console.log("-".repeat(60));

  for (let i = 0; i < Math.min(count, 5); i++) {
    const w = hdNode.deriveChild(i);
    console.log("  [" + i + "] " + w.address);
  }
  if (count > 5) console.log("  ... dan " + (count - 5) + " wallet lainnya.");
  console.log("-".repeat(60) + "\n");
}

// ============================================================
// MODE 2: Run Bot Auto (Pure-API SIWE)
// ============================================================

async function processOneAuto(walletInfo, inviteCode, baseUrl) {
  const tag = "[" + walletInfo.index + "] " + short(walletInfo.address);

  const w = deriveOne(process.env.MNEMONIC, walletInfo.index);
  if (w.address.toLowerCase() !== walletInfo.address.toLowerCase()) {
    console.log("  " + tag + " address mismatch, skip");
    return { success: false, error: "address mismatch" };
  }

  console.log("  " + tag + " SIWE login + invite_code=" + (inviteCode || "(none)"));
  const login = await siweLogin(w.ethersWallet, inviteCode, baseUrl);

  if (!login.success) {
    console.log("  " + tag + " [X] Login gagal: " + login.error);
    return { success: false, error: login.error };
  }

  // confirm session with /v1/me
  let me = null;
  try {
    const meRes = await getMe(login.client);
    if (meRes.success) me = meRes.data;
  } catch (e) {}

  // pull referral codes for this new account
  let codes = null;
  try {
    const ic = await getInviteCodes(login.client, { status: "all", page: 1 });
    if (ic.success) codes = ic.data;
  } catch (e) {}

  console.log("  " + tag + " [OK] login sukses" + (me && me.account ? " | user=" + (me.account.id || me.account.address || "?") : ""));

  return {
    success: true,
    account: login.account,
    me: me,
    inviteCodes: codes,
    cookie: login.jar.header(),
  };
}

async function modeRunBotAuto() {
  const { MNEMONIC, INVITE_CODE, MAX_INDEX, DELAY_MS, BASE_URL } = process.env;
  if (!MNEMONIC) { console.error("\nSet MNEMONIC di .env (atau jalankan menu 1)!"); return; }

  const maxIndex = parseInt(MAX_INDEX || "50");
  const delayMs = parseInt(DELAY_MS || "5000");
  const inviteCode = (INVITE_CODE || "").trim();
  const baseUrl = (BASE_URL || "https://app.neotrade.pro").replace(/\/$/, "");

  console.log("\n=== neotrade.pro Referral Bot (Auto — Pure-API SIWE) ===");
  console.log("Base URL    : " + baseUrl);
  console.log("Invite Code : " + (inviteCode || "(none — akan signup tanpa referral)"));
  console.log("Scan Index  : 0 - " + (maxIndex - 1));
  console.log("Captcha     : tidak diperlukan (neotrade.pro tidak pakai captcha)\n");

  const wallets = deriveWallets(MNEMONIC, maxIndex);
  const remaining = wallets.filter((w) => !isAlreadyProcessed(w.index));

  console.log("Total Wallet: " + maxIndex);
  console.log("Sudah Selesai: " + (maxIndex - remaining.length));
  console.log("Tersisa      : " + remaining.length + "\n");

  if (remaining.length === 0) {
    console.log("Semua wallet (0 - " + (maxIndex - 1) + ") sudah berhasil diproses!\n");
    return;
  }

  const startConfirm = await askQuestion("Mulai auto-run " + remaining.length + " wallet tersisa? (y/n): ");
  if (startConfirm.toLowerCase() !== "y") {
    console.log("Dibatalkan.");
    return;
  }

  console.log("\nMemulai pemrosesan otomatis " + remaining.length + " wallet...\n");

  for (let i = 0; i < wallets.length; i++) {
    const walletInfo = wallets[i];

    if (isAlreadyProcessed(walletInfo.index)) {
      console.log("  [" + walletInfo.index + "] " + short(walletInfo.address) + " | skip (sudah selesai)");
      continue;
    }

    console.log("\n" + "=".repeat(50));
    console.log("PROSES WALLET [" + walletInfo.index + " / " + (maxIndex - 1) + "]");
    console.log("=".repeat(50));
    console.log("Address    : " + walletInfo.address);
    console.log("=".repeat(50));

    try {
      const result = await processOneAuto(walletInfo, inviteCode, baseUrl);

      if (result.success) {
        const me = result.me || {};
        const acc = (me.account) || result.account || {};
        saveProcessedWallet({
          index: walletInfo.index,
          address: walletInfo.address,
          status: "success",
          userId: acc.id || acc.user_id || acc.address || null,
          inviteCode: inviteCode || null,
          account: result.account || null,
          inviteCodes: result.inviteCodes || null,
          cookie: result.cookie || null,
          error: null,
          timestamp: new Date().toISOString(),
        });
        console.log("  [OK] SUKSES! Index " + walletInfo.index + (acc.id ? " | User: " + acc.id : ""));
        if (result.inviteCodes) {
          console.log("  [OK] Invite codes: " + JSON.stringify(result.inviteCodes).slice(0, 160));
        }
      } else {
        saveProcessedWallet({
          index: walletInfo.index,
          address: walletInfo.address,
          status: "failed",
          error: result.error,
          timestamp: new Date().toISOString(),
        });
        console.log("\n  [X] Gagal: " + result.error);
      }
    } catch (err) {
      console.log("\n  [X] Error: " + err.message);
      saveProcessedWallet({
        index: walletInfo.index,
        address: walletInfo.address,
        status: "failed",
        error: err.message,
        timestamp: new Date().toISOString(),
      });
    }

    console.log("  Menunggu jeda " + (delayMs / 1000) + " detik...");
    await sleep(delayMs);
  }

  console.log("\n" + "=".repeat(60));
  console.log("  SEMUA WALLET SELESAI DIPROSES!");
  console.log("=".repeat(60) + "\n");
}

// ============================================================
// MODE 3: Run Bot Manual (interactive browser)
// ============================================================

async function modeRunBotManual() {
  const { MNEMONIC, INVITE_CODE, MAX_INDEX, DELAY_MS, BASE_URL } = process.env;
  if (!MNEMONIC) { console.error("\nSet MNEMONIC di .env (atau jalankan menu 1)!"); return; }

  const maxIndex = parseInt(MAX_INDEX || "50");
  const delayMs = parseInt(DELAY_MS || "3000");
  const inviteCode = (INVITE_CODE || "").trim();
  const baseUrl = (BASE_URL || "https://app.neotrade.pro").replace(/\/$/, "");

  console.log("\n=== neotrade.pro Referral Bot (Manual — Browser interaktif) ===");
  console.log("Base URL    : " + baseUrl);
  console.log("Invite Code : " + (inviteCode || "(none)"));
  console.log("Scan Index  : 0 - " + (maxIndex - 1) + "\n");

  const wallets = deriveWallets(MNEMONIC, maxIndex);

  for (const walletInfo of wallets) {
    if (isAlreadyProcessed(walletInfo.index)) {
      console.log("  [" + walletInfo.index + "] " + short(walletInfo.address) + " | skip");
      continue;
    }

    console.log("\n" + "-".repeat(50));
    console.log("WALLET [" + walletInfo.index + "]");
    console.log("-".repeat(50));
    console.log("Address    : " + walletInfo.address);
    console.log("Private Key: " + walletInfo.privateKey);
    console.log("-".repeat(50));

    const proceed = await askQuestion("Lanjut buka browser? (y/n): ");
    if (proceed.toLowerCase() !== "y") continue;

    try {
      const result = await openBrowserManual(walletInfo, inviteCode, baseUrl);

      if (result.success) {
        saveProcessedWallet({
          index: walletInfo.index,
          address: walletInfo.address,
          status: "success",
          inviteCode: inviteCode || null,
          cookie: result.cookieHeader || null,
          cookies: result.cookies || null,
          localStorage: result.localStorage || null,
          note: "manual signup",
          error: null,
          timestamp: new Date().toISOString(),
        });
        console.log("  [OK] Sesi ter-capture & tersimpan.");
        if (result.warning) console.log("  [!] " + result.warning);
      } else {
        console.log("  Gagal: " + (result.error || result.warning || "unknown"));
        saveProcessedWallet({
          index: walletInfo.index,
          address: walletInfo.address,
          status: "failed",
          error: result.error || result.warning || "manual failed",
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.log("  Error: " + err.message);
    }

    await sleep(delayMs);
  }
}

// ============================================================
// MODE 4: Check Referral Status
// ============================================================

async function modeCheckReferral() {
  const { BASE_URL } = process.env;
  const baseUrl = (BASE_URL || "https://app.neotrade.pro").replace(/\/$/, "");

  const processed = loadProcessedWallets();
  const successWallets = processed.filter((w) => w.status === "success" && w.cookie);
  if (successWallets.length === 0) {
    console.log("\nBelum ada wallet dengan sesi aktif (cookie) untuk di-check.\n");
    return;
  }

  console.log("\nChecking referral status untuk " + successWallets.length + " wallet...\n");

  for (const w of successWallets) {
    const tag = "[" + w.index + "] " + short(w.address);
    try {
      // rebuild a client from the saved cookie
      const jar = new CookieJar();
      // naive: parse our stored "name=value; name2=value2" cookie string
      if (w.cookie) {
        for (const pair of String(w.cookie).split(";")) {
          const eq = pair.indexOf("=");
          if (eq > 0) jar.cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
        }
      }
      const client = makeClient(baseUrl, jar);

      const meRes = await getMe(client);
      if (meRes.success) {
        const acc = (meRes.data && meRes.data.account) || meRes.data || {};
        console.log(tag + " me=" + JSON.stringify({ id: acc.id || acc.user_id, address: acc.address, invite_code: acc.invite_code }).slice(0, 180));
      } else {
        console.log(tag + " /v1/me gagal: " + meRes.error);
      }

      const ic = await getInviteCodes(client, { status: "all", page: 1 });
      if (ic.success) {
        console.log(tag + " invite-codes: " + JSON.stringify(ic.data).slice(0, 220));
      } else {
        console.log(tag + " invite-codes gagal: " + ic.error);
      }
    } catch (err) {
      console.log(tag + " Error: " + err.message);
    }
    await sleep(1000);
  }
}

// ============================================================
// MODE 5: View Processed Wallets
// ============================================================

function modeViewProcessed() {
  const processed = loadProcessedWallets();
  if (processed.length === 0) {
    console.log("\nBelum ada wallet yang diproses.\n");
    return;
  }
  console.log("\n" + "=".repeat(60));
  console.log("  PROCESSED WALLETS (" + processed.length + ")");
  console.log("=".repeat(60));
  for (const w of processed) {
    const status = w.status === "success" ? "OK" : "FAIL";
    console.log("  [" + w.index + "] " + short(w.address, 12) + " | " + status + " | " + (w.timestamp || "N/A"));
    if (w.userId) console.log("         User ID: " + w.userId);
    if (w.inviteCode) console.log("         Invite: " + w.inviteCode);
    if (w.error) console.log("         Error: " + String(w.error).slice(0, 80));
  }
  console.log("=".repeat(60) + "\n");
}

// ============================================================
// MODE 6: Reset Wallet Data
// ============================================================

async function modeResetWallets() {
  console.log("\n" + "=".repeat(60));
  console.log("  RESET WALLET DATA");
  console.log("=".repeat(60));
  console.log("Perhatian: Ini akan mengosongkan processed_wallets.json");
  console.log("dan menghapus MNEMONIC dari .env.\n");

  const confirm = await askQuestion("Apakah Anda yakin ingin melakukan reset? (y/n): ");
  if (confirm.toLowerCase() !== "y") {
    console.log("Reset dibatalkan.\n");
    return;
  }

  clearProcessedWallets();
  console.log("  [OK] processed_wallets.json berhasil dikosongkan.");

  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, "utf8");
    envContent = envContent.replace(/^MNEMONIC=.*/m, "MNEMONIC=");
    fs.writeFileSync(envPath, envContent);
    process.env.MNEMONIC = "";
    console.log("  [OK] MNEMONIC di .env berhasil dikosongkan.");
  }

  console.log("\n[SUCCESS] Reset wallet selesai!\n");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  try {
    // allow `npm run auto` to skip the menu and run auto immediately
    const arg = process.argv[2];
    if (arg === "--auto") {
      await modeRunBotAuto();
      return;
    }

    while (true) {
      await showMenu();
      const choice = await askQuestion("Pilihan: ");

      switch (choice.trim()) {
        case "1": await modeGenerateWallet(); break;
        case "2": await modeRunBotAuto(); break;
        case "3": await modeRunBotManual(); break;
        case "4": await modeCheckReferral(); break;
        case "5": modeViewProcessed(); break;
        case "6": await modeResetWallets(); break;
        case "0": console.log("\nBye!\n"); process.exit(0);
        default: console.log("\nPilihan tidak valid!\n");
      }
    }
  } catch (err) {
    if (err.message && err.message.includes("readline")) {
      console.log("\n\nProgram selesai.\n");
    } else {
      console.error("Error:", err.message);
    }
    process.exit(0);
  }
}

main();
