const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const PROCESSED_FILE = path.join(__dirname, "processed_wallets.json");

// ============================================================
// HD WALLET DERIVATION  (BIP-44: m/44'/60'/0'/0/index)
// ============================================================

function deriveWallets(mnemonic, count) {
  const wallets = [];
  const hdNode = ethers.HDNodeWallet.fromMnemonic(
    ethers.Mnemonic.fromPhrase(mnemonic),
    "m/44'/60'/0'/0"
  );
  for (let i = 0; i < count; i++) {
    const wallet = hdNode.deriveChild(i);
    wallets.push({
      index: i,
      address: wallet.address,
      privateKey: wallet.privateKey,
    });
  }
  return wallets;
}

function deriveOne(mnemonic, index) {
  const hdNode = ethers.HDNodeWallet.fromMnemonic(
    ethers.Mnemonic.fromPhrase(mnemonic),
    "m/44'/60'/0'/0"
  );
  const wallet = hdNode.deriveChild(index);
  return {
    index: index,
    address: wallet.address,
    privateKey: wallet.privateKey,
    ethersWallet: new ethers.Wallet(wallet.privateKey),
  };
}

// ============================================================
// PROCESSED WALLETS TRACKING
// ============================================================

function loadProcessedWallets() {
  try {
    if (fs.existsSync(PROCESSED_FILE)) {
      return JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf8"));
    }
  } catch (e) {}
  return [];
}

function saveProcessedWallets(wallets) {
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify(wallets, null, 2));
}

function saveProcessedWallet(wallet) {
  const wallets = loadProcessedWallets();
  const existing = wallets.findIndex(
    (w) => w.index === wallet.index || w.address === wallet.address
  );
  if (existing >= 0) {
    wallets[existing] = { ...wallets[existing], ...wallet };
  } else {
    wallets.push(wallet);
  }
  saveProcessedWallets(wallets);
}

function isAlreadyProcessed(index) {
  const wallets = loadProcessedWallets();
  return wallets.some((w) => w.index === index && w.status === "success");
}

function clearProcessedWallets() {
  saveProcessedWallets([]);
}

module.exports = {
  deriveWallets,
  deriveOne,
  loadProcessedWallets,
  saveProcessedWallets,
  saveProcessedWallet,
  isAlreadyProcessed,
  clearProcessedWallets,
};
