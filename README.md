# Keep — a private diary

A password- and biometric-protected diary that installs on Windows and Android and syncs through your own Google Drive. It's a **PWA** (progressive web app): one set of files, no app store, works in Chrome/Edge on both platforms.

## What's actually protected

- Every entry is encrypted on your device with AES-256-GCM before it touches disk or Drive. The key comes from your password (PBKDF2, 250,000 rounds) — it's never stored anywhere.
- Google only ever sees ciphertext. The file it stores (`keep-diary-vault.json`) is unreadable without your password.
- Biometric unlock (fingerprint / Windows Hello / Android fingerprint) uses the WebAuthn **PRF extension** to unwrap your real key locally — it's a convenience, not a separate password. It only works on Chrome/Edge 132+ on a device with a fingerprint/face sensor. If your browser doesn't support PRF, the biometric button just won't appear — no fake security.
- There's no password reset. Losing the password means losing the entries (that's the honest trade-off of real encryption).

## 1. Set up your own Google Cloud credentials (required for sync)

Drive sync needs an OAuth client that belongs to *you*, not a shared one baked into the app.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create a new project (any name, e.g. "Keep Diary").
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen** → choose **External** → fill in the app name, your email, and add your own Google account under "Test users" (this keeps it private to you, no Google review needed).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID** → Application type **Web application**.
5. Under **Authorized JavaScript origins**, add the exact URL you'll host this on (see step 2), for example:
   - `https://yourname.github.io` (GitHub Pages)
   - `http://localhost:5500` (local testing)
6. Copy the generated Client ID (looks like `123456-abc.apps.googleusercontent.com`).
7. Open `app.js` and replace:
   ```js
   GOOGLE_CLIENT_ID: "YOUR_CLIENT_ID.apps.googleusercontent.com",
   ```
   with your real client ID.

The app works fully offline without this step — you just won't have the "Connect Google Drive" button do anything until it's set.

## 2. Host it somewhere with HTTPS

Google OAuth and biometric unlock both require a real origin (not `file://`). Easiest free option:

**GitHub Pages**
1. Create a new GitHub repo, upload everything in this folder.
2. Repo → Settings → Pages → Deploy from branch → `main` → save.
3. Your app is live at `https://yourname.github.io/reponame/`.
4. Go back and make sure that exact URL is in your OAuth "Authorized JavaScript origins" (step 1.5 above).

**Local testing** — any static file server works, e.g. VS Code's "Live Server" extension, or:
```
python3 -m http.server 5500
```
then visit `http://localhost:5500`.

## 3. Install it on Windows

1. Open the hosted URL in Chrome or Edge.
2. Click the install icon in the address bar (or menu → "Install Keep…").
3. It now opens like a normal app, with its own window and Start Menu entry.

## 4. Install it on Android

1. Open the hosted URL in Chrome.
2. Menu (⋮) → "Add to Home screen" / "Install app".
3. It appears as a regular app icon.

## Setting up a second device

The first time you open Keep on a **new** device, you'll see two options:

- **Create diary** — only use this if this is genuinely the first device you've ever used Keep on.
- **Restore from Google Drive instead** — use this on every device *after* the first one. It signs you into Google Drive, finds your existing encrypted diary, and drops you on the unlock screen for it. Type the **same password** you used on your first device.

Don't tap "Create diary" on a second device — each device that creates its own diary generates its own random encryption key, even with an identical password. Two devices with two different keys can't read each other's entries, and syncing between them will surface a "couldn't decrypt this entry" error. If that already happened to you:

1. On the affected device, go to Settings → **Erase this device**. Your real entries are untouched — they're safe in Drive.
2. On the setup screen that appears, tap **Restore from Google Drive instead** and sign in.
3. Enter the correct password (the one your first device uses) to unlock.

## Streaks

A day counts toward your streak the moment you save any entry for that date. The current streak, longest streak, and every entry date are stored inside your encrypted vault file — since that file lives in **your** Google Drive account, your streak is tied to your Google account across every device you sign into.

## Files in this folder

| File | Purpose |
|---|---|
| `index.html` | App shell and screens |
| `style.css` | Visual design |
| `app.js` | Encryption, calendar, streaks, biometric unlock, Drive sync — **edit `CONFIG` at the top** |
| `manifest.json` | Makes it installable |
| `sw.js` | Offline support |
| `icons/` | App icons |

## Limitations, honestly

- This is a web app packaged as an installable PWA — not a native `.exe`/`.apk` from the Play Store or Microsoft Store. It behaves like an app (own window, own icon, works offline) but is still running in Chrome/Edge's engine.
- Biometric unlock needs a fairly recent Chrome/Edge and PRF support — on older browsers you'll always fall back to password.
- If two devices edit the *same day's* entry while offline and then both sync, the version with the later timestamp wins — the other is discarded. For a personal diary this is rarely an issue, but worth knowing.
- If a device somehow still ends up on a different password/salt than your main diary (see "Setting up a second device" above), sync will now stop and ask you to type that diary's real password before touching anything — it won't silently mix unreadable data into your entries again.
- Whenever you update any of the app files (index.html, app.js, sw.js, etc.), also bump the `CACHE_NAME` value in `sw.js` (e.g. "keep-diary-v2" → "keep-diary-v3"). Browsers cache these files aggressively for offline use, and without a version bump, devices may keep running the old code even after you've pushed a fix.
