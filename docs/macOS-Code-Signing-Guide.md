# macOS Code Signing & Notarization Guide for GogChat

**Purpose:** This document provides a complete step-by-step guide to set up macOS code signing and notarization for distributing signed DMG files outside the Mac App Store.

**Prerequisites:**

- A Mac computer
- An Apple ID with two-factor authentication enabled
- $99/year for Apple Developer Program membership

---

## Table of Contents

1. [Overview](#1-overview)
2. [Phase 1: Apple Developer Account Setup](#2-phase-1-apple-developer-account-setup)
3. [Phase 2: Create Developer ID Certificates](#3-phase-2-create-developer-id-certificates)
4. [Phase 3: Export Certificate as .p12 File](#4-phase-3-export-certificate-as-p12-file)
5. [Phase 4: Create App-Specific Password](#5-phase-4-create-app-specific-password)
6. [Phase 5: Configure Environment Variables](#6-phase-5-configure-environment-variables)
7. [Phase 6: Integrate with Build Pipeline](#7-phase-6-integrate-with-build-pipeline)
8. [Phase 7: Test the Signed Build](#8-phase-7-test-the-signed-build)
9. [Troubleshooting](#9-troubleshooting)
10. [Quick Reference](#10-quick-reference)

---

## 1. Overview

### What You Need

| Item                                     | Description                      | Where to Get It               |
| ---------------------------------------- | -------------------------------- | ----------------------------- |
| **Developer ID Application Certificate** | Signs your .app bundle           | Apple Developer Portal        |
| **Developer ID Installer Certificate**   | Signs .pkg installers (optional) | Apple Developer Portal        |
| **CSC_LINK**                             | Base64-encoded .p12 certificate  | Export from Keychain          |
| **CSC_KEY_PASSWORD**                     | Password for .p12 file           | You create this               |
| **APPLE_ID**                             | Your Apple ID email              | Your Apple account            |
| **APPLE_TEAM_ID**                        | 10-character team identifier     | Developer Portal → Membership |
| **APPLE_APP_PASSWORD**                   | App-specific password            | appleid.apple.com             |

> **Env name:** `scripts/notarize.cjs` and release signing helpers read **`APPLE_APP_PASSWORD` only**. Do not use `APPLE_APP_SPECIFIC_PASSWORD` — that name is obsolete in this repo and will cause notarization to be skipped.

### How the Build Pipeline Works

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    build-macOS-dmg.sh --enable-code-sign               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. Rsbuild compiles TypeScript → lib/                                  │
│                      ↓                                                  │
│  2. electron-builder reads:                                             │
│     - electron-builder.yml (base config)                               │
│     - electron-builder.sign.yml (signing extensions)                    │
│                      ↓                                                  │
│  3. Code signing with CSC_LINK + CSC_KEY_PASSWORD                       │
│     - hardenedRuntime: true                                             │
│     - entitlements.mac.plist applied                                    │
│                      ↓                                                  │
│  4. afterSign hook: scripts/notarize.cjs                                │
│     - Uploads to Apple using APPLE_ID + APPLE_APP_PASSWORD     │
│     - Waits for Apple's malware scan                                    │
│     - Staples the notarization ticket                                   │
│                      ↓                                                  │
│  5. Output: Signed & Notarized DMG in dist/                             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Phase 1: Apple Developer Account Setup

### Step 2.1: Enroll in Apple Developer Program

1. Go to [developer.apple.com/programs/enroll/](https://developer.apple.com/programs/enroll/)
2. Click **"Start your enrollment"**
3. Sign in with your Apple ID (must have 2FA enabled)
4. Choose your entity type:

   **Option A: Individual** (Simpler, faster)
   - Use your legal name (no aliases or nicknames)
   - Your personal name appears as "Seller" on App Store
   - No D-U-N-S number required
   - Cost: $99/year

   **Option B: Organization** (Recommended for businesses)
   - Requires D-U-N-S Number (free from Dun & Bradstreet)
   - Organization name appears as "Seller"
   - Takes 1-2 weeks for verification
   - Cost: $99/year

5. Complete identity verification:
   - For individuals: Apple may call you to verify identity
   - For organizations: Submit business documents

6. Pay $99 annual fee

7. **Wait for approval** (typically 24-48 hours for individuals, 1-2 weeks for organizations)

### Step 2.2: Get Your Team ID

After enrollment is approved:

1. Go to [developer.apple.com/account](https://developer.apple.com/account)
2. Click **"Membership"** in the left sidebar
3. Find **"Team ID"** — it's a 10-character alphanumeric string (e.g., `ABC12DEF34`)
4. **Save this value** — you'll need it for `APPLE_TEAM_ID`

---

## 3. Phase 2: Create Developer ID Certificates

### Step 3.1: Create a Certificate Signing Request (CSR)

1. Open **Keychain Access** (Applications → Utilities → Keychain Access)

2. From the menu bar: **Keychain Access → Certificate Assistant → Request a Certificate from a Certificate Authority...**

3. Fill in the form:
   - **User Email Address:** Your Apple ID email
   - **Common Name:** Something descriptive like `iworkforces Developer ID`
   - **CA Email Address:** Leave empty
   - **Request is:** Select **"Saved to disk"**

4. Click **Continue** and save the file (e.g., `CertificateSigningRequest.certSigningRequest`)

### Step 3.2: Request the Certificate from Apple

1. Go to [developer.apple.com/account/resources/certificates/list](https://developer.apple.com/account/resources/certificates/list)

2. Click the **"+"** button to create a new certificate

3. Select **"Developer ID Application"** (for signing apps distributed outside the App Store)
   - ⚠️ **Important:** Do NOT select "Apple Development" or "Mac Development" — those are only for App Store distribution

4. Click **Continue**

5. Upload your CSR file (the one you created in Step 3.1)

6. Click **Continue**

7. **Download the certificate** (it will be a `.cer` file)

### Step 3.3: Install the Certificate

1. Double-click the downloaded `.cer` file
2. It will be added to your **Login** keychain
3. Verify installation:
   - In Keychain Access, go to **"My Certificates"** category
   - You should see "Developer ID Application: [Your Name] ([Team ID])"
   - ⚠️ **Critical:** There must be a disclosure triangle next to it indicating a private key is attached
   - If no private key is visible, see [Troubleshooting](#9-troubleshooting)

### Step 3.4: (Optional) Create Developer ID Installer Certificate

If you plan to distribute via .pkg installers:

1. Repeat Steps 3.1-3.3, but select **"Developer ID Installer"** instead

---

## 4. Phase 3: Export Certificate as .p12 File

This step creates the file that electron-builder uses for code signing.

### Step 4.1: Export from Keychain

1. Open **Keychain Access**

2. Go to **"My Certificates"** category

3. Right-click on **"Developer ID Application: [Your Name] ([Team ID])"**

4. Select **"Export 'Developer ID Application: ...'"**

5. Choose a location and filename (e.g., `developer-id-application.p12`)

6. Enter a **strong password** for the .p12 file — this will be your `CSC_KEY_PASSWORD`

7. You may be prompted to enter your Mac login password to allow the export

### Step 4.2: Convert to Base64 (for CI/CD)

For GitHub Actions or other CI systems, you need to store the certificate as a base64-encoded string:

```bash
# macOS/Linux
base64 -i developer-id-application.p12 -o certificate-base64.txt

# The output file contains the base64 string for CSC_LINK
```

**Example output:**

```
MIIMAQIBAzCCCX8GCSqGSIb3DQEHAaCCCXAEgglsMIIFaDCCBW8GCSqGSIb3DQEHAqCCBW4EggVq...
```

⚠️ **Security:** Never commit the .p12 file or base64 string to git!

---

## 5. Phase 4: Create App-Specific Password

Apple requires an app-specific password (not your Apple ID password) for notarization.

### Step 5.1: Generate the Password

1. Go to [appleid.apple.com](https://appleid.apple.com)

2. Sign in with your Apple ID

3. Go to **"Sign-In and Security"** → **"App-Specific Passwords"**

4. Click the **"+"** button

5. Enter a label like **"GogChat Notarization"**

6. Click **"Create"**

7. **Copy the generated password immediately** — it looks like `xxxx-xxxx-xxxx-xxxx`

8. **Save this value** — you'll need it for `APPLE_APP_PASSWORD`

⚠️ **Note:** You can only view this password once. If you lose it, you'll need to generate a new one.

---

## 6. Phase 5: Configure Environment Variables

### Step 6.1: Local Development (Optional)

For local builds, you can set environment variables in your shell:

```bash
# Add to ~/.zshrc or ~/.bashrc
export CSC_LINK="/path/to/developer-id-application.p12"
export CSC_KEY_PASSWORD="your-p12-password"
export APPLE_ID="your-apple-id@email.com"
export APPLE_TEAM_ID="ABC12DEF34"
export APPLE_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"
```

Or create a `.env` file (add to .gitignore!):

```bash
# .env (NEVER commit this file!)
CSC_LINK=/path/to/developer-id-application.p12
CSC_KEY_PASSWORD=your-p12-password
APPLE_ID=your-apple-id@email.com
APPLE_TEAM_ID=ABC12DEF34
APPLE_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

### Step 6.2: GitHub Actions Configuration

Add the following secrets to your GitHub repository:

1. Go to your repository → **Settings** → **Secrets and variables** → **Actions**

2. Click **"New repository secret"** for each:

   | Secret Name                   | Value                                                            |
   | ----------------------------- | ---------------------------------------------------------------- |
   | `CSC_LINK`                    | Base64-encoded certificate (content of `certificate-base64.txt`) |
   | `CSC_KEY_PASSWORD`            | Password you set for the .p12 file                               |
   | `APPLE_ID`                    | Your Apple ID email address                                      |
   | `APPLE_TEAM_ID`               | 10-character Team ID from developer portal                       |
   | `APPLE_APP_PASSWORD` | App-specific password from appleid.apple.com                     |

### Step 6.3: Verify Required Variables

| Variable                      | Used By          | Purpose                                                      |
| ----------------------------- | ---------------- | ------------------------------------------------------------ |
| `CSC_LINK`                    | electron-builder | Path to .p12 certificate                                     |
| `CSC_KEY_PASSWORD`            | electron-builder | Password to decrypt .p12                                     |
| `CSC_IDENTITY_AUTO_DISCOVERY` | electron-builder | Set to `false` to disable auto-discovery (used in local dev) |
| `APPLE_ID`                    | notarize.cjs     | Apple ID for notarization                                    |
| `APPLE_TEAM_ID`               | notarize.cjs     | Team ID for notarization                                     |
| `APPLE_APP_PASSWORD` | notarize.cjs     | App-specific password for notarization                       |

---

## 7. Phase 6: Integrate with Build Pipeline

### Current Pipeline Overview

Your project already has the infrastructure in place:

```
GogChat/
├── build-macOS-dmg.sh          # Unified build script (use --enable-code-sign)
├── electron-builder.yml         # Base configuration
├── electron-builder.sign.yml    # Code signing extensions (merged when signing enabled)
├── entitlements.mac.plist       # App entitlements
├── entitlements.mac.inherit.plist
└── scripts/
    └── notarize.cjs           # After-sign notarization hook
```

### Step 7.1: Build with Code Signing

```bash
# Set environment variables first
export CSC_LINK="/path/to/developer-id-application.p12"
export CSC_KEY_PASSWORD="your-p12-password"
export APPLE_ID="your-apple-id@email.com"
export APPLE_TEAM_ID="ABC12DEF34"
export APPLE_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"

# Run build with code signing enabled
./build-macOS-dmg.sh --environment production --enable-code-sign

# Build specific architecture (arm64 default)
./build-macOS-dmg.sh --environment production --enable-code-sign
```

### Step 7.2: How It Works

When you run with `--enable-code-sign`:

1. **Script sets up signing environment:**

   ```bash
   # From build-macOS-dmg.sh
   unset CSC_IDENTITY_AUTO_DISCOVERY
   CONFIG_FILES="electron-builder.yml electron-builder.sign.yml"
   ```

2. **electron-builder merges configs:**
   - `electron-builder.yml` — base config
   - `electron-builder.sign.yml` — adds `hardenedRuntime: true` and entitlements

3. **Code signing happens:**
   - electron-builder reads `CSC_LINK` and `CSC_KEY_PASSWORD`
   - Signs the app with your Developer ID certificate
   - Applies hardened runtime and entitlements

4. **Notarization hook runs:**
   - `scripts/notarize.cjs` is triggered by `afterSign` hook
   - Uploads signed app to Apple
   - Waits for malware scan (5-15 minutes)
   - Staples notarization ticket to app

5. **DMG is created:**
   - Final signed and notarized DMG in `dist/`

### Step 7.3: Release workflow integration

The current release workflow is split into `prepare-release`, `build-mac`, `build-windows`, `verify-release-artifacts`, and one `publish-release` job. Add macOS signing credentials to the `build-mac` job. Do not add a separate upload step from the macOS signing guide, because publishing happens once after aggregate artifact verification.

```yaml
# .github/workflows/release.yml
jobs:
  build-mac:
    needs: prepare-release
    if: needs.prepare-release.outputs.should_release == 'true'
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0

      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with:
          bun-version: "1.4.2"

      - name: Setup Node
        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: '24.16.0'

      - run: bun install --frozen-lockfile

      - run: bun run build:prod

      - name: Build macOS DMG
        env:
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          APPLE_APP_PASSWORD: ${{ secrets.APPLE_APP_PASSWORD }}
        run: bun run package:mac:release

      - name: Upload macOS DMG artifact
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: release-macos-dmg
          path: dist/*.dmg
          if-no-files-found: error
```

Windows release engineering/preparation is handled by separate guarded jobs. It is not a public support claim. Windows release publication requires a Windows Authenticode signing route through `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` or explicit owner opt-in for unsigned Windows assets through the signing policy gate, and support/publication claims require clean packaged smoke on Windows x64 and real Windows arm64.

---

## 8. Phase 7: Test the Signed Build

### Step 8.1: Verify Code Signing

```bash
# Check if app is properly signed
codesign -vvv --deep --strict dist/mac-arm64/Google\ Chat.app

# Expected output:
# dist/mac-arm64/GogChat.app: valid on disk
# dist/mac-arm64/GogChat.app: satisfies its Designated Requirement
```

### Step 8.2: Verify Notarization

```bash
# Check notarization status
spctl --assess --verbose --type execute dist/mac-arm64/Google\ Chat.app

# Expected output:
# dist/mac-arm64/GogChat.app: accepted
# source=Notarized Developer ID

# Or check the stapled ticket
stapler validate dist/mac-arm64/Google\ Chat.app

# Expected output:
# Processing: dist/mac-arm64/GogChat.app
# The validate action worked!
```

### Step 8.3: Test on Another Mac

1. Copy the DMG to another Mac
2. Open the DMG
3. Drag the app to Applications
4. Launch the app
5. **Expected:** No Gatekeeper warnings — app launches directly

### Step 8.4: Test Gatekeeper from Command Line

```bash
# Simulate first launch on user's machine
xattr -cr dist/mac-arm64/Google\ Chat.app
spctl --assess --verbose --type execute dist/mac-arm64/Google\ Chat.app
```

---

## 9. Troubleshooting

### Problem: Certificate shows no private key

**Symptoms:**

- In Keychain Access, no disclosure triangle next to certificate
- electron-builder fails with "no identity found"

**Solution:**

1. The private key was created on a different Mac
2. Export the private key from the original Mac's Keychain
3. Import both the .p12 and the private key to your new Mac

**Prevention:**

- Always back up your .p12 file with the private key included
- The CSR must be created on the same Mac where you import the certificate

### Problem: "no identity found" during build

**Symptoms:**

```
Error: No identity found for signing
```

**Solutions:**

1. Verify certificate is in Login keychain (not System)
2. Check certificate hasn't expired
3. Ensure private key is attached
4. Try setting `CSC_NAME` explicitly:
   ```bash
   export CSC_NAME="Developer ID Application: Your Name (ABC12DEF34)"
   ```

### Problem: Notarization fails with "signature invalid"

**Symptoms:**

```
"message": "The signature of the binary is invalid."
```

**Solution:**

1. Ensure hardened runtime is enabled
2. Check entitlements are properly applied
3. Re-sign with `--deep` flag:
   ```bash
   codesign --deep --force --verify --verbose --sign "Developer ID Application: Your Name" --options runtime --timestamp "GogChat.app"
   ```

### Problem: Notarization fails with "missing secure timestamp"

**Symptoms:**

```
"message": "The signature does not include a secure timestamp."
```

**Solution:**
electron-builder should handle this automatically, but verify your `electron-builder.sign.yml` has:

```yaml
mac:
  hardenedRuntime: true
```

### Problem: Notarization stuck "in progress"

**Symptoms:**

- Notarization takes longer than 15 minutes
- Status shows "in progress" indefinitely

**Solutions:**

1. Check Apple's system status: [developer.apple.com/system-status/](https://developer.apple.com/system-status/)
2. Cancel and retry:
   ```bash
   xcrun notarytool log <submission-id> --apple-id "email" --team-id "ABC12DEF34" --password "xxxx-xxxx-xxxx-xxxx"
   ```

### Problem: "altool has been decommissioned"

**Symptoms:**

```
Error: Notarization of MacOS applications using altool has been decommissioned. Please use notarytool.
```

**Solution:**
Your `scripts/notarize.cjs` already uses the correct API. Ensure you're using `@electron/notarize` version 3.x+.

### Problem: CSC_LINK in GitHub Actions not working

**Symptoms:**

- Certificate not found in CI
- Base64 decode issues

**Solution:**

```yaml
- name: Prepare certificate
  env:
    CSC_LINK: ${{ secrets.CSC_LINK }}
  run: |
    # Decode base64 to file
    echo "$CSC_LINK" | base64 --decode > certificate.p12
    export CSC_LINK="$(pwd)/certificate.p12"
    echo "CSC_LINK=$(pwd)/certificate.p12" >> $GITHUB_ENV
```

---

## 10. Quick Reference

### Environment Variables Summary

```bash
# Code Signing
export CSC_LINK="/path/to/certificate.p12"        # Or base64 string
export CSC_KEY_PASSWORD="your-password"
export CSC_IDENTITY_AUTO_DISCOVERY=false          # Disable auto-discovery

# Notarization
export APPLE_ID="your-apple-id@email.com"
export APPLE_TEAM_ID="ABC12DEF34"                 # 10-char Team ID
export APPLE_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"
```

### Useful Commands

```bash
# List available signing identities
security find-identity -v -p codesigning

# Verify app signature
codesign -vvv --deep --strict "GogChat.app"

# Check notarization
spctl --assess --verbose --type execute "GogChat.app"
stapler validate "GogChat.app"

# Manual notarization (if needed)
xcrun notarytool submit "app.zip" \
  --apple-id "email" \
  --team-id "ABC12DEF34" \
  --password "xxxx-xxxx-xxxx-xxxx" \
  --wait

# Check notarization history
xcrun notarytool history \
  --apple-id "email" \
  --team-id "ABC12DEF34" \
  --password "xxxx-xxxx-xxxx-xxxx"
```

### Build Commands

```bash
# Without code signing (development)
./build-macOS-dmg.sh --environment develop

# With code signing (production)
./build-macOS-dmg.sh --environment production --enable-code-sign
```

### File Locations

| File                             | Purpose                               |
| -------------------------------- | ------------------------------------- |
| `build-macOS-dmg.sh`             | Main build script                     |
| `electron-builder.yml`           | Base electron-builder config          |
| `electron-builder.sign.yml`      | Code signing extensions               |
| `entitlements.mac.plist`         | App entitlements (JIT, network, etc.) |
| `entitlements.mac.inherit.plist` | Entitlements for child processes      |
| `scripts/notarize.cjs`           | Notarization after-sign hook          |

---

## Checklist

- [ ] Enroll in Apple Developer Program ($99/year)
- [ ] Get Team ID from Membership page
- [ ] Create CSR in Keychain Access
- [ ] Request Developer ID Application certificate
- [ ] Install certificate in Login keychain
- [ ] Verify private key is attached
- [ ] Export as .p12 file with password
- [ ] Convert .p12 to base64 (for CI)
- [ ] Create app-specific password at appleid.apple.com
- [ ] Add secrets to GitHub repository
- [ ] Test local build with `--enable-code-sign`
- [ ] Verify code signature with `codesign -vvv`
- [ ] Verify notarization with `spctl --assess`
- [ ] Test on clean Mac (no warnings expected)

---

_Last updated: February 2026_
_For GogChat v3.4.5+_
