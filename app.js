"use strict";

/* =========================================================
   CONFIG — you must fill this in. See README.md.
   ========================================================= */
const CONFIG = {
  GOOGLE_CLIENT_ID: 607277864672-ndkbborg6n4601ekh48uiv3i82ugk58i.apps.googleusercontent.com,
  DRIVE_SCOPE: "https://www.googleapis.com/auth/drive.file",
  DRIVE_FILE_NAME: "keep-diary-vault.json",
};

/* =========================================================
   TINY IndexedDB HELPER
   ========================================================= */
const DB_NAME = "keep-diary";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readonly");
    const req = tx.objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* =========================================================
   CRYPTO
   ========================================================= */
const enc = new TextEncoder();
const dec = new TextDecoder();

function bufToB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b64ToBuf(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}
function randomBytes(len) {
  return crypto.getRandomValues(new Uint8Array(len));
}

async function deriveKeyFromPassword(password, saltB64) {
  const salt = new Uint8Array(b64ToBuf(saltB64));
  const baseKey = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

async function aesEncrypt(key, plaintext) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, enc.encode(plaintext)
  );
  return { iv: bufToB64(iv), ct: bufToB64(ct) };
}

async function aesDecrypt(key, payload) {
  const iv = new Uint8Array(b64ToBuf(payload.iv));
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv }, key, b64ToBuf(payload.ct)
  );
  return dec.decode(pt);
}

async function exportRawKey(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return bufToB64(raw);
}
async function importRawKey(b64) {
  return crypto.subtle.importKey("raw", b64ToBuf(b64), "AES-GCM", true, ["encrypt", "decrypt"]);
}

/* =========================================================
   APP STATE
   ========================================================= */
const state = {
  vault: null,       // decrypted-in-memory shape: { salt, verifier, entries: {date:{iv,ct,updatedAt}}, streak, driveFileId }
  vaultKey: null,     // CryptoKey, only ever in memory
  selectedDate: null, // "YYYY-MM-DD"
  calendarMonth: new Date(),
  driveAccessToken: null,
};

function todayStr() {
  return localDateStr(new Date());
}
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}

/* =========================================================
   VAULT PERSISTENCE (local)
   ========================================================= */
async function saveVaultLocal() {
  await idbSet("vault", state.vault);
}
async function loadVaultLocal() {
  return idbGet("vault");
}

/* =========================================================
   STREAK CALC
   ========================================================= */
function recomputeStreak() {
  const dates = Object.keys(state.vault.entries).sort();
  if (dates.length === 0) {
    state.vault.streak = { current: 0, longest: 0, lastEntryDate: null };
    return;
  }
  const dateSet = new Set(dates);
  // longest streak: scan sorted dates
  let longest = 1, run = 1;
  for (let i = 1; i < dates.length; i++) {
    if (addDays(dates[i - 1], 1) === dates[i]) {
      run += 1;
    } else {
      run = 1;
    }
    longest = Math.max(longest, run);
  }

  // current streak: walk backward from today (or yesterday if today has no entry yet)
  let cursor = dateSet.has(todayStr()) ? todayStr() : addDays(todayStr(), -1);
  let current = 0;
  while (dateSet.has(cursor)) {
    current += 1;
    cursor = addDays(cursor, -1);
  }

  state.vault.streak = { current, longest, lastEntryDate: dates[dates.length - 1] };
}

/* =========================================================
   TOAST
   ========================================================= */
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
}

/* =========================================================
   LOCK SCREEN LOGIC
   ========================================================= */
async function initLockScreen() {
  const existing = await loadVaultLocal();
  const setupView = document.getElementById("setupView");
  const unlockView = document.getElementById("unlockView");

  if (existing) {
    state.vault = existing;
    unlockView.classList.remove("hidden");
    maybeShowBiometricButton();
  } else {
    setupView.classList.remove("hidden");
  }
}

document.getElementById("setupSubmit").addEventListener("click", async () => {
  const p1 = document.getElementById("setupPassword").value;
  const p2 = document.getElementById("setupPasswordConfirm").value;
  const errorEl = document.getElementById("setupError");
  errorEl.textContent = "";

  if (p1.length < 8) { errorEl.textContent = "Use at least 8 characters."; return; }
  if (p1 !== p2) { errorEl.textContent = "Passwords don't match."; return; }

  const salt = bufToB64(randomBytes(16));
  const key = await deriveKeyFromPassword(p1, salt);
  const verifier = await aesEncrypt(key, "keep-vault-ok");

  state.vault = {
    salt,
    verifier,
    entries: {},
    streak: { current: 0, longest: 0, lastEntryDate: null },
    driveFileId: null,
  };
  state.vaultKey = key;
  await saveVaultLocal();
  enterApp();
});

document.getElementById("unlockSubmit").addEventListener("click", async () => {
  const pass = document.getElementById("unlockPassword").value;
  const errorEl = document.getElementById("unlockError");
  errorEl.textContent = "";
  try {
    const key = await deriveKeyFromPassword(pass, state.vault.salt);
    const check = await aesDecrypt(key, state.vault.verifier);
    if (check !== "keep-vault-ok") throw new Error("bad password");
    state.vaultKey = key;
    enterApp();
  } catch {
    errorEl.textContent = "Wrong password. Try again.";
  }
});

document.getElementById("unlockPassword").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("unlockSubmit").click();
});

function enterApp() {
  document.getElementById("lockScreen").classList.add("hidden");
  document.getElementById("appScreen").classList.remove("hidden");
  document.getElementById("unlockPassword").value = "";
  renderCalendar();
  updateStreakUI();
  refreshDriveStatusUI();
  refreshBiometricStatusUI();
}

document.getElementById("lockBtn").addEventListener("click", () => {
  state.vaultKey = null;
  document.getElementById("appScreen").classList.add("hidden");
  document.getElementById("lockScreen").classList.remove("hidden");
  document.getElementById("unlockView").classList.remove("hidden");
  document.getElementById("setupView").classList.add("hidden");
  closeEntryEditor();
});

/* =========================================================
   BIOMETRIC UNLOCK (WebAuthn + PRF extension)
   ========================================================= */
function biometricSupported() {
  return !!(window.PublicKeyCredential && navigator.credentials);
}

async function platformAuthenticatorAvailable() {
  if (!biometricSupported()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

async function maybeShowBiometricButton() {
  const bio = await idbGet("bio");
  const btn = document.getElementById("biometricUnlockBtn");
  if (bio && (await platformAuthenticatorAvailable())) {
    btn.classList.remove("hidden");
  } else {
    btn.classList.add("hidden");
  }
}

document.getElementById("biometricUnlockBtn").addEventListener("click", async () => {
  const errorEl = document.getElementById("unlockError");
  errorEl.textContent = "";
  try {
    const bio = await idbGet("bio");
    if (!bio) throw new Error("not enabled");
    const salt = new Uint8Array(b64ToBuf(bio.prfSalt));
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: [{ id: b64ToBuf(bio.credentialId), type: "public-key" }],
        userVerification: "required",
        extensions: { prf: { eval: { first: salt } } },
      },
    });
    const results = assertion.getClientExtensionResults();
    const prfOutput = results?.prf?.results?.first;
    if (!prfOutput) throw new Error("PRF unavailable");
    const wrapKey = await crypto.subtle.importKey("raw", prfOutput, "AES-GCM", false, ["decrypt"]);
    const rawVaultKeyB64 = await aesDecrypt(wrapKey, bio.wrapped);
    state.vaultKey = await importRawKey(rawVaultKeyB64);
    enterApp();
  } catch (err) {
    console.error(err);
    errorEl.textContent = "Biometric unlock failed. Use your password instead.";
  }
});

async function enableBiometric() {
  if (!(await platformAuthenticatorAvailable())) {
    toast("This device has no fingerprint/face unlock available.");
    return;
  }
  try {
    const prfSalt = randomBytes(32);
    const userId = randomBytes(16);
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { name: "Keep" },
        user: { id: userId, name: "keep-user", displayName: "Keep diary" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
        extensions: { prf: {} },
        timeout: 60000,
      },
    });
    const supportsPRF = cred.getClientExtensionResults()?.prf?.enabled;
    if (!supportsPRF) {
      toast("This browser doesn't support secure biometric key storage yet.");
      return;
    }
    // Get PRF output for this credential right away
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: [{ id: cred.rawId, type: "public-key" }],
        userVerification: "required",
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
    const prfOutput = assertion.getClientExtensionResults()?.prf?.results?.first;
    if (!prfOutput) throw new Error("no PRF output");

    const wrapKey = await crypto.subtle.importKey("raw", prfOutput, "AES-GCM", false, ["encrypt"]);
    const rawVaultKeyB64 = await exportRawKey(state.vaultKey);
    const wrapped = await aesEncrypt(wrapKey, rawVaultKeyB64);

    await idbSet("bio", {
      credentialId: bufToB64(cred.rawId),
      prfSalt: bufToB64(prfSalt),
      wrapped,
    });
    toast("Biometric unlock enabled on this device.");
    refreshBiometricStatusUI();
  } catch (err) {
    console.error(err);
    toast("Couldn't enable biometric unlock.");
  }
}

async function disableBiometric() {
  await idbDelete("bio");
  toast("Biometric unlock disabled on this device.");
  refreshBiometricStatusUI();
}

async function refreshBiometricStatusUI() {
  const statusEl = document.getElementById("biometricStatus");
  const enableBtn = document.getElementById("enableBiometricBtn");
  const disableBtn = document.getElementById("disableBiometricBtn");
  const supported = await platformAuthenticatorAvailable();
  const bio = await idbGet("bio");

  if (!supported) {
    statusEl.textContent = "Not available on this device or browser.";
    enableBtn.classList.add("hidden");
    disableBtn.classList.add("hidden");
  } else if (bio) {
    statusEl.textContent = "Enabled on this device.";
    enableBtn.classList.add("hidden");
    disableBtn.classList.remove("hidden");
  } else {
    statusEl.textContent = "Available — use your fingerprint or face instead of typing your password.";
    enableBtn.classList.remove("hidden");
    disableBtn.classList.add("hidden");
  }
}

document.getElementById("enableBiometricBtn").addEventListener("click", enableBiometric);
document.getElementById("disableBiometricBtn").addEventListener("click", disableBiometric);

/* =========================================================
   CALENDAR RENDERING
   ========================================================= */
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function renderCalendar() {
  const grid = document.getElementById("calendarGrid");
  const label = document.getElementById("monthLabel");
  const m = state.calendarMonth;
  label.textContent = `${MONTH_NAMES[m.getMonth()]} ${m.getFullYear()}`;

  grid.innerHTML = "";
  const firstOfMonth = new Date(m.getFullYear(), m.getMonth(), 1);
  const startOffset = firstOfMonth.getDay();
  const daysInMonth = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  const today = todayStr();
  const entryDates = new Set(Object.keys(state.vault.entries));

  for (let i = 0; i < startOffset; i++) {
    const filler = document.createElement("div");
    filler.className = "cal-day empty";
    grid.appendChild(filler);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const cell = document.createElement("button");
    cell.className = "cal-day";
    cell.type = "button";
    if (dateStr === today) cell.classList.add("today");
    if (entryDates.has(dateStr)) cell.classList.add("has-entry");
    if (dateStr === state.selectedDate) cell.classList.add("selected");
    if (isWithinCurrentStreak(dateStr)) cell.classList.add("streak-day");

    const num = document.createElement("span");
    num.textContent = day;
    cell.appendChild(num);
    if (entryDates.has(dateStr)) {
      const dot = document.createElement("span");
      dot.className = "dot";
      cell.appendChild(dot);
    }
    cell.addEventListener("click", () => selectDate(dateStr));
    grid.appendChild(cell);
  }
}

function isWithinCurrentStreak(dateStr) {
  const streak = state.vault.streak;
  if (!streak || streak.current === 0) return false;
  const start = dateStr <= todayStr() ? todayStr() : null;
  // simplest check: within [today - current+1, today] or [yesterday-current+1, yesterday]
  const anchor = state.vault.entries[todayStr()] ? todayStr() : addDays(todayStr(), -1);
  let cursor = anchor;
  for (let i = 0; i < streak.current; i++) {
    if (cursor === dateStr) return true;
    cursor = addDays(cursor, -1);
  }
  return false;
}

document.getElementById("prevMonth").addEventListener("click", () => {
  state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() - 1, 1);
  renderCalendar();
});
document.getElementById("nextMonth").addEventListener("click", () => {
  state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + 1, 1);
  renderCalendar();
});

function updateStreakUI() {
  const s = state.vault.streak || { current: 0, longest: 0 };
  document.getElementById("streakCount").textContent = s.current;
  document.getElementById("currentStreakStat").textContent = s.current;
  document.getElementById("longestStreakStat").textContent = s.longest;
  document.getElementById("totalEntriesStat").textContent = Object.keys(state.vault.entries).length;
}

/* =========================================================
   ENTRY EDITOR
   ========================================================= */
function formatDateLong(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

async function selectDate(dateStr) {
  state.selectedDate = dateStr;
  renderCalendar();
  document.getElementById("entryEmpty").classList.add("hidden");
  document.getElementById("entryEditor").classList.remove("hidden");
  document.getElementById("entryDateLabel").textContent = formatDateLong(dateStr);
  document.getElementById("saveStatus").textContent = "";

  const record = state.vault.entries[dateStr];
  const textarea = document.getElementById("entryText");
  if (record) {
    try {
      textarea.value = await aesDecrypt(state.vaultKey, record);
    } catch {
      textarea.value = "";
      toast("Couldn't decrypt this entry.");
    }
  } else {
    textarea.value = "";
  }
  textarea.focus();
}

function closeEntryEditor() {
  state.selectedDate = null;
  document.getElementById("entryEditor").classList.add("hidden");
  document.getElementById("entryEmpty").classList.remove("hidden");
  renderCalendar();
}

document.getElementById("writeTodayBtn").addEventListener("click", () => selectDate(todayStr()));
document.getElementById("closeEntryBtn").addEventListener("click", closeEntryEditor);

document.getElementById("saveEntryBtn").addEventListener("click", async () => {
  if (!state.selectedDate) return;
  const text = document.getElementById("entryText").value;
  const statusEl = document.getElementById("saveStatus");

  if (text.trim() === "") {
    delete state.vault.entries[state.selectedDate];
  } else {
    const payload = await aesEncrypt(state.vaultKey, text);
    payload.updatedAt = Date.now();
    state.vault.entries[state.selectedDate] = payload;
  }
  recomputeStreak();
  await saveVaultLocal();
  updateStreakUI();
  renderCalendar();
  statusEl.textContent = "Saved " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
});

/* =========================================================
   SETTINGS DRAWER
   ========================================================= */
document.getElementById("settingsBtn").addEventListener("click", () => {
  document.getElementById("settingsDrawer").classList.remove("hidden");
  refreshDriveStatusUI();
  refreshBiometricStatusUI();
});
document.getElementById("closeSettingsBtn").addEventListener("click", () => {
  document.getElementById("settingsDrawer").classList.add("hidden");
});

document.getElementById("changePasswordBtn").addEventListener("click", async () => {
  const oldPass = document.getElementById("oldPasswordInput").value;
  const newPass = document.getElementById("newPasswordInput").value;
  const errorEl = document.getElementById("changePasswordError");
  errorEl.textContent = "";

  if (newPass.length < 8) { errorEl.textContent = "New password needs 8+ characters."; return; }

  try {
    const oldKey = await deriveKeyFromPassword(oldPass, state.vault.salt);
    const check = await aesDecrypt(oldKey, state.vault.verifier);
    if (check !== "keep-vault-ok") throw new Error("bad password");

    // Re-encrypt every entry under a new key/salt
    const newSalt = bufToB64(randomBytes(16));
    const newKey = await deriveKeyFromPassword(newPass, newSalt);
    const newEntries = {};
    for (const [date, payload] of Object.entries(state.vault.entries)) {
      const plain = await aesDecrypt(state.vaultKey, payload);
      const reEncrypted = await aesEncrypt(newKey, plain);
      reEncrypted.updatedAt = payload.updatedAt;
      newEntries[date] = reEncrypted;
    }
    state.vault.salt = newSalt;
    state.vault.verifier = await aesEncrypt(newKey, "keep-vault-ok");
    state.vault.entries = newEntries;
    state.vaultKey = newKey;
    await saveVaultLocal();
    await idbDelete("bio"); // biometric wrap is bound to the old key — must re-enable
    refreshBiometricStatusUI();

    document.getElementById("oldPasswordInput").value = "";
    document.getElementById("newPasswordInput").value = "";
    toast("Password updated. Re-enable biometric unlock if you use it.");
  } catch {
    errorEl.textContent = "Current password is incorrect.";
  }
});

document.getElementById("wipeDeviceBtn").addEventListener("click", async () => {
  if (!confirm("This erases your diary from this device only. Continue?")) return;
  await idbDelete("vault");
  await idbDelete("bio");
  location.reload();
});

/* =========================================================
   GOOGLE DRIVE SYNC
   ========================================================= */
let tokenClient = null;

function initGoogleClient() {
  if (!window.google || CONFIG.GOOGLE_CLIENT_ID.startsWith("YOUR_CLIENT_ID")) return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    scope: CONFIG.DRIVE_SCOPE,
    callback: async (resp) => {
      if (resp.error) { toast("Google sign-in failed."); return; }
      state.driveAccessToken = resp.access_token;
      await idbSet("driveConnected", true);
      refreshDriveStatusUI();
      await syncWithDrive();
    },
  });
}

async function refreshDriveStatusUI() {
  const statusEl = document.getElementById("driveStatus");
  const connectBtn = document.getElementById("connectDriveBtn");
  const disconnectBtn = document.getElementById("disconnectDriveBtn");
  const connected = await idbGet("driveConnected");

  if (CONFIG.GOOGLE_CLIENT_ID.startsWith("YOUR_CLIENT_ID")) {
    statusEl.textContent = "Not configured yet — see README.md to add your Google Client ID.";
    connectBtn.classList.add("hidden");
    disconnectBtn.classList.add("hidden");
    return;
  }

  if (connected && state.driveAccessToken) {
    statusEl.textContent = "Connected. Syncing automatically.";
    connectBtn.classList.add("hidden");
    disconnectBtn.classList.remove("hidden");
  } else if (connected) {
    statusEl.textContent = "Previously connected — click to reconnect this session.";
    connectBtn.classList.remove("hidden");
    connectBtn.textContent = "Reconnect Google Drive";
    disconnectBtn.classList.add("hidden");
  } else {
    statusEl.textContent = "Not connected.";
    connectBtn.classList.remove("hidden");
    connectBtn.textContent = "Connect Google Drive";
    disconnectBtn.classList.add("hidden");
  }
}

document.getElementById("connectDriveBtn").addEventListener("click", () => {
  if (!tokenClient) { toast("Google sign-in isn't configured yet."); return; }
  tokenClient.requestAccessToken();
});

document.getElementById("disconnectDriveBtn").addEventListener("click", async () => {
  state.driveAccessToken = null;
  await idbDelete("driveConnected");
  refreshDriveStatusUI();
  toast("Disconnected from Google Drive.");
});

document.getElementById("syncBtn").addEventListener("click", async () => {
  if (!state.driveAccessToken) {
    if (tokenClient) tokenClient.requestAccessToken();
    else toast("Google sign-in isn't configured yet. See README.md.");
    return;
  }
  await syncWithDrive();
});

async function driveFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${state.driveAccessToken}` },
  });
  if (!res.ok) throw new Error(`Drive API error: ${res.status}`);
  return res;
}

async function findDriveVaultFile() {
  const q = encodeURIComponent(`name='${CONFIG.DRIVE_FILE_NAME}' and trashed=false`);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`);
  const data = await res.json();
  return data.files && data.files[0] ? data.files[0].id : null;
}

async function downloadDriveVault(fileId) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  return res.json();
}

async function uploadDriveVault(fileId, content) {
  const metadata = { name: CONFIG.DRIVE_FILE_NAME, mimeType: "application/json" };
  const boundary = "keep-boundary-" + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(content)}\r\n` +
    `--${boundary}--`;

  const url = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

  const res = await driveFetch(url, {
    method: fileId ? "PATCH" : "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return res.json();
}

function mergeEntries(localEntries, remoteEntries) {
  const merged = { ...localEntries };
  for (const [date, remotePayload] of Object.entries(remoteEntries || {})) {
    const localPayload = merged[date];
    if (!localPayload || (remotePayload.updatedAt || 0) > (localPayload.updatedAt || 0)) {
      merged[date] = remotePayload;
    }
  }
  return merged;
}

async function syncWithDrive() {
  if (!state.driveAccessToken) return;
  toast("Syncing…");
  try {
    const fileId = state.vault.driveFileId || (await findDriveVaultFile());
    if (fileId) {
      const remote = await downloadDriveVault(fileId);
      // Entries are already encrypted — only merge ciphertext blobs, never plaintext.
      if (remote.salt && remote.salt !== state.vault.salt && Object.keys(state.vault.entries).length === 0) {
        // Fresh device, existing remote vault: adopt it wholesale (still password-locked with its own salt).
        toast("Found an existing diary on Drive. Unlock it with that diary's password next time.");
      }
      state.vault.entries = mergeEntries(state.vault.entries, remote.entries);
      state.vault.driveFileId = fileId;
    }
    recomputeStreak();
    await saveVaultLocal();

    const payload = {
      salt: state.vault.salt,
      verifier: state.vault.verifier,
      entries: state.vault.entries,
      streak: state.vault.streak,
      syncedAt: Date.now(),
    };
    const result = await uploadDriveVault(state.vault.driveFileId, payload);
    if (result.id) state.vault.driveFileId = result.id;
    await saveVaultLocal();

    updateStreakUI();
    renderCalendar();
    toast("Synced with Google Drive.");
  } catch (err) {
    console.error(err);
    toast("Sync failed. Check your connection and try again.");
  }
}

/* =========================================================
   PWA SERVICE WORKER
   ========================================================= */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

/* =========================================================
   BOOT
   ========================================================= */
window.addEventListener("load", () => {
  initGoogleClient();
  setTimeout(initGoogleClient, 800); // in case gsi script loads slightly late
});

initLockScreen();
