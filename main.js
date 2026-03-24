const { app, BrowserWindow, Tray, Menu, nativeImage, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const net = require('net');
const { ipcMain } = require('electron');
const DiscordRPC = require('discord-rpc');

// ── Discord RPC ────────────────────────────────────────────────
const clientId = '1352311651475718214'; // MiGu Music App ID
const rpc = new DiscordRPC.Client({ transport: 'ipc' });

let rpcConnected = false;

async function setActivity(data) {
  if (!rpc || !rpcConnected) return;

  const activity = {
    details: data.title || 'Đang nghe nhạc',
    state: data.author || 'MiGu Music',
    largeImageKey: 'logo',
    largeImageText: 'MiGu Music',
    instance: false,
  };

  if (data.isPlaying && data.duration) {
    const startTimestamp = Date.now();
    const endTimestamp = startTimestamp + (data.duration - data.currentTime) * 1000;
    activity.startTimestamp = startTimestamp;
    activity.endTimestamp = endTimestamp;
  }

  rpc.setActivity(activity).catch(() => {});
}

rpc.on('ready', () => {
  rpcConnected = true;
  console.log('[Discord] RPC Connected');
});

rpc.login({ clientId }).catch(console.error);

ipcMain.on('update-rpc', (event, data) => {
  setActivity(data);
});

// ── Memory Optimization cho máy 8GB RAM ────────────────────────
app.commandLine.appendSwitch('renderer-process-limit', '1'); // Giới hạn chỉ mở 1 process cho giao diện
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256'); // Ép V8 Engine dọn rác sớm, không ngốn RAM
app.commandLine.appendSwitch('disable-site-isolation-trials'); // Giảm Overhead RAM của Chromium
// ───────────────────────────────────────────────────────────────

const PORT = 3000;
const ICON_PATH = path.join(__dirname, 'public', 'icon.png');

let mainWindow;
let tray;

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
  
  // ── Auto Update ──────────────────────────────────────────────
  // Check for updates every 1 hour
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify();
  }, 60 * 60 * 1000);

  // Initial check
  console.log('[Updater] Checking for updates... Current version:', app.getVersion());
  autoUpdater.checkForUpdatesAndNotify();
});

// Auto-update event handlers
autoUpdater.on('update-available', () => {
  console.log('[Updater] Update available.');
});

autoUpdater.on('update-not-available', () => {
  console.log('[Updater] Update not available.');
});

autoUpdater.on('error', (err) => {
  console.error('[Updater] Error in auto-updater:', err);
});

autoUpdater.on('download-progress', (progressObj) => {
  let log_message = "Download speed: " + progressObj.bytesPerSecond;
  log_message = log_message + ' - Downloaded ' + progressObj.percent + '%';
  log_message = log_message + ' (' + progressObj.transferred + "/" + progressObj.total + ')';
  console.log('[Updater] ' + log_message);
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('[Updater] Update downloaded');
  dialog.showMessageBox({
    type: 'info',
    title: 'Cập nhật sẵn sàng',
    message: `Phiên bản mới (${info.version}) đã được tải về. Bạn có muốn khởi động lại để cập nhật ngay không?`,
    buttons: ['Cập nhật ngay', 'Để sau'],
    defaultId: 0,
    cancelId: 1
  }).then((result) => {
    if (result.response === 0) {
      autoUpdater.quitAndInstall();
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
