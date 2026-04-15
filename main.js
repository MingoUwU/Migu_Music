const { app, BrowserWindow, Tray, Menu, nativeImage, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { ipcMain } = require('electron');

// ── Memory Optimization cho máy 8GB RAM ────────────────────────
app.commandLine.appendSwitch('renderer-process-limit', '1'); // Giới hạn chỉ mở 1 process cho giao diện
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512'); // Cân bằng RAM/CPU, tránh GC quá dày gây tốn CPU
app.commandLine.appendSwitch('disable-site-isolation-trials'); // Giảm Overhead RAM của Chromium
// ───────────────────────────────────────────────────────────────

const PORT = 3000;
const ICON_PATH = path.join(__dirname, 'public', 'icon.png');

let mainWindow;
let tray;
let manualUpdateCheck = false;
let rendererReadyForUpdater = false;

/** Dùng generic + URL /releases/latest/download/ — ổn định hơn chỉ dựa vào GitHub API (ít bị chặn / lệch provider). */
const MIGU_UPDATE_FEED_BASE =
  process.env.MIGU_UPDATE_BASE || 'https://github.com/MingoUwU/Migu_Music/releases/latest/download/';

function sendUpdateEvent(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-event', payload);
  }
}

// ── Check if port already in use ──────────────────────────────
function isPortInUse(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => { srv.close(); resolve(false); });
    srv.listen(port);
  });
}

async function startServer() {
  const inUse = await isPortInUse(PORT);
  if (!inUse) {
    require('./server');
    console.log('[MiGu] Started internal server on port', PORT);
    // Give it a tiny moment to actually bind
    await new Promise(r => setTimeout(r, 500));
  } else {
    console.log('[MiGu] Port already in use — connecting to existing server');
  }
}

// ── Create main window ────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: '#050510',
    icon: ICON_PATH,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: true, // Tối ưu CPU/RAM khi thu nhỏ xuống khay hệ thống
      spellcheck: false // Tắt tính năng kiểm tra chính tả của Chromium (tiết kiệm ~20-30MB RAM)
    },
    show: false,
  });

  // Block DevTools shortcuts
  /*
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (
      input.key === 'F12' ||
      (input.control && input.shift && input.key.toLowerCase() === 'i') ||
      (input.control && input.shift && input.key.toLowerCase() === 'j') ||
      (input.control && input.shift && input.key.toLowerCase() === 'c')
    ) {
      event.preventDefault();
    }
  });
  */

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Minimize to tray instead of closing
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  function emitVisibility(hidden) {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app-visibility', { hidden: !!hidden });
      }
    } catch (_) { /* ignore */ }
  }

  mainWindow.on('hide', () => emitVisibility(true));
  mainWindow.on('show', () => emitVisibility(false));
  mainWindow.on('minimize', () => emitVisibility(true));

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── System Tray ───────────────────────────────────────────────
function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '🎵 MiGu Music',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Mở ứng dụng',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Thoát',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('MiGu Music');
  tray.setContextMenu(contextMenu);

  // Double-click tray icon to open
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── App lifecycle ─────────────────────────────────────────────
app.whenReady().then(async () => {
  await startServer();
  createWindow();
  createTray();
  
  // ── Auto Update Logic ────────────────────────────────────────
  autoUpdater.autoDownload = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  if (app.isPackaged) {
    // Tránh client/CDN trả latest.yml cũ — giúp thấy bản release mới sớm hơn
    autoUpdater.requestHeaders = {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
    };
    try {
      autoUpdater.setFeedURL({ provider: 'generic', url: MIGU_UPDATE_FEED_BASE });
      console.log('[Updater] Feed (generic):', MIGU_UPDATE_FEED_BASE);
    } catch (e) {
      console.warn('[Updater] setFeedURL generic failed, dùng app-update.yml gốc:', e);
    }
  }

  function checkUpdates() {
    if (!app.isPackaged) {
      console.warn('[Updater] Bỏ qua: đang chạy từ mã nguồn (npm start). Chỉ bản cài .exe mới kiểm tra GitHub Release.');
      return;
    }
    console.log('[Updater] Checking for updates... Current version:', app.getVersion());
    // Dùng checkForUpdates (không dùng checkForUpdatesAndNotify) để tránh notification hệ thống trùng với modal trong app
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[Updater] Failed to check for updates:', err);
      sendUpdateEvent({
        type: 'error',
        message: (err && err.message) || String(err),
      });
    });
  }

  ipcMain.on('renderer-ready', () => {
    console.log('[Updater] Renderer ready.');
    rendererReadyForUpdater = true;
    if (!app.isPackaged) {
      sendUpdateEvent({
        type: 'dev-mode',
        message:
          'Đang chạy bản phát triển (npm start) — không kiểm tra cập nhật từ GitHub. Cài bản .exe và đăng latest.yml + file cài lên Release thì app mới báo có bản mới.',
      });
      return;
    }
    // Trễ để renderer kịp gắn ipcRenderer.on('update-event' / 'update-msg')
    setTimeout(() => checkUpdates(), 1200);
  });

  // Dự phòng: nếu renderer không gửi signal (lỗi hiếm), vẫn thử check sau vài giây
  setTimeout(() => {
    if (!app.isPackaged || rendererReadyForUpdater) return;
    console.warn('[Updater] Chưa nhận renderer-ready — thử checkForUpdates dự phòng.');
    checkUpdates();
  }, 8000);

  // Mỗi 30 phút + khi mở lại cửa sổ (xem handler show bên dưới)
  setInterval(() => {
    if (app.isPackaged) checkUpdates();
  }, 30 * 60 * 1000);

  let lastShowUpdateCheck = 0;
  const SHOW_UPDATE_COOLDOWN_MS = 3 * 60 * 1000;
  function attachShowUpdateCheck() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.on('show', () => {
      if (!app.isPackaged) return;
      const now = Date.now();
      if (now - lastShowUpdateCheck < SHOW_UPDATE_COOLDOWN_MS) return;
      lastShowUpdateCheck = now;
      setTimeout(() => checkUpdates(), 400);
    });
  }
  attachShowUpdateCheck();

  ipcMain.on('manual-check-update', () => {
    if (!app.isPackaged) {
      sendUpdateEvent({
        type: 'dev-mode',
        message: 'Chỉ bản đã đóng gói (.exe) mới kiểm tra cập nhật từ GitHub.',
      });
      return;
    }
    manualUpdateCheck = true;
    checkUpdates();
  });

  ipcMain.on('quit-and-install', () => {
    app.isQuitting = true;
    autoUpdater.quitAndInstall(false, true);
  });
});

autoUpdater.on('checking-for-update', () => {
  console.log('[Updater] checking-for-update');
  sendUpdateEvent({ type: 'checking' });
});

autoUpdater.on('update-available', (info) => {
  console.log('[Updater] Update available.', info.version);
  const payload = {
    type: 'available',
    version: info.version,
    releaseNotes: info.releaseNotes,
  };
  sendUpdateEvent(payload);
  // Tương thích bản cũ chỉ lắng nghe update-msg (toast vẫn thấy được)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(
      'update-msg',
      `Có bản cập nhật mới v${info.version}. Đang tải tự động…`
    );
  }
});

autoUpdater.on('update-not-available', (info) => {
  const remote = info && (info.version || info.updateInfo?.version);
  console.log('[Updater] Update not available. App:', app.getVersion(), 'remote:', remote || '(none)');
  const fromManual = manualUpdateCheck;
  manualUpdateCheck = false;
  sendUpdateEvent({
    type: 'not-available',
    version: app.getVersion(),
    fromManual,
    remoteVersion: remote || null,
  });
});

autoUpdater.on('error', (err) => {
  console.error('[Updater] Error in auto-updater:', err);
  manualUpdateCheck = false;
  let message = (err && err.message) || String(err);
  if (/404|not found|latest\.yml|HttpError/i.test(message)) {
    message +=
      ' — Thường do: Release chưa Publish (còn nháp), thiếu file latest.yml hoặc file .exe trên GitHub, hoặc chưa chạy npm run release (cần GH_TOKEN) để đẩy artifact lên Release.';
  }
  sendUpdateEvent({ type: 'error', message });
});

autoUpdater.on('download-progress', (progressObj) => {
  const pct = Math.round(progressObj.percent || 0);
  console.log('[Updater] Download', pct + '%', progressObj.bytesPerSecond, 'B/s');
  sendUpdateEvent({ type: 'progress', percent: pct });
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('[Updater] Update downloaded', info.version);
  const appName = app.getName() || 'MiGu Music';
  sendUpdateEvent({ type: 'downloaded', version: info.version });

  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    } catch (_) { /* ignore */ }
    mainWindow.webContents.send(
      'update-msg',
      `${appName}: Đã tải xong bản v${info.version} — xem hộp thoại trong cửa sổ ${appName}.`
    );
    return;
  }

  let boxIcon = undefined;
  try {
    if (ICON_PATH && fs.existsSync(ICON_PATH)) {
      boxIcon = nativeImage.createFromPath(ICON_PATH);
    }
  } catch (_) { /* ignore */ }

  dialog
    .showMessageBox({
      type: 'info',
      title: `${appName} — Cập nhật sẵn sàng`,
      message: `${appName} có phiên bản mới (${info.version}) đã được tải về.`,
      detail: 'Khởi động lại MiGu Music để hoàn tất cài đặt.',
      buttons: ['Khởi động lại & cập nhật', 'Để sau'],
      defaultId: 0,
      cancelId: 1,
      ...(boxIcon ? { icon: boxIcon } : {}),
    })
    .then((result) => {
      if (result.response === 0) {
        app.isQuitting = true;
        autoUpdater.quitAndInstall(false, true);
      }
    });
});

app.on('window-all-closed', () => {
  // Don't quit on Windows — stay in tray
  if (process.platform !== 'darwin' && !app.isQuitting) {
    // do nothing, tray keeps app alive
  }
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});
