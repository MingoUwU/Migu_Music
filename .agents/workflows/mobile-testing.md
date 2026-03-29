---
description: How to build and test the mobile (APK) version of MiGu Music
---

Follow these steps to build and test the latest "Liquid Glass" redesign on the MuMu Player emulator.

### 1. Sync Changes to GitHub
Ensure all recent "Liquid Glass" redesigns and PC stabilizes are pushed to the `Mobile` branch.
// turbo
1. Commit and push: `git add . && git commit -m "Sync mobile redesign" && git push origin Mobile`

### 2. Trigger & Monitor GitHub Actions
This project uses GitHub Actions to build the APK.
1. Navigate to the **Actions** tab on your GitHub repository.
2. Look for the workflow named **"Android Build"**.
3. Wait for the build to complete (usually 5-10 minutes).

### 3. Download the APK
1. Click on the completed "Android Build" run.
2. Scroll to the **Artifacts** section at the bottom.
3. Download the `app-release.apk` or `app-debug.apk`.

### 4. Install on MuMu Player
1. Open your **MuMu Player** emulator.
2. **Drag and Drop** the downloaded `.apk` file into the MuMu window.
3. Once installed, click the MiGu Music icon to launch.

### 5. Verification Checklist
- [ ] **Navigation:** Bottom nav buttons correctly switch views.
- [ ] **Liquid Glass:** Room view cards show blur and translucency.
- [ ] **Responsive:** Content fits perfectly without horizontal scrolling.
- [ ] **Performance:** Music playback is smooth on the emulator.

> [!TIP]
> If the app fails to load content, ensure the server is running at the IP address specified in your mobile config (usually `capacitor.config.json`).
