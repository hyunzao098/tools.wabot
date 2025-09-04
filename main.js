const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia} = require('whatsapp-web.js');
const { autoUpdater } = require("electron-updater");


// --- Puppeteer Executable Path Fix for Electron ---
let chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"; // Windows
if (chromePath.includes('app.asar')) {
  chromePath = chromePath.replace('app.asar', 'app.asar.unpacked');
}
process.env.PUPPETEER_EXECUTABLE_PATH = chromePath;

// --- File Paths ---
const SESSION_FOLDER = path.join(app.getPath('userData'), 'sessions');

// --- Load / Save Functions ---
function loadJson(filePath, fallback = []) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath));
    }
  } catch (e) {
    console.error(`❌ Failed to load ${filePath}:`, e);
  }
  return fallback;
}
function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}
function deleteFolderRecursive(folderPath) {
  if (fs.existsSync(folderPath)) {
    fs.rmSync(folderPath, { recursive: true, force: true });
  }
}
function getKeywordFile(sessionId) {
  return path.join(app.getPath('userData'), `keywords_${sessionId}.json`);
}
function getDefaultMessageFile(sessionId) {
  return path.join(app.getPath('userData'), `default_message_${sessionId}.json`);
}
function getSentDefaultsFile(sessionId) {
  return path.join(app.getPath('userData'), `sent_defaults_${sessionId}.json`);
}

// --- Globals ---
let win = null;


// Timer reset
let RESET_INTERVAL = 1440 * 60 * 1000; // default 24 jam
let resetTimer = null;

// --- Default Message ---
let keywordResponses = {
  session1: loadJson(getKeywordFile("session1"), []),
  session2: loadJson(getKeywordFile("session2"), [])
};

let defaultMessages = {
  session1: "Halo! Selamat datang di Nomor 1",
  session2: "Halo! Selamat datang di Nomor 2"
};
if (fs.existsSync(getDefaultMessageFile("session1"))) {
  defaultMessages.session1 = JSON.parse(fs.readFileSync(getDefaultMessageFile("session1"))).message || "";
}
if (fs.existsSync(getDefaultMessageFile("session2"))) {
  defaultMessages.session2 = JSON.parse(fs.readFileSync(getDefaultMessageFile("session2"))).message || "";
}


let defaultMessageSent = {
  session1: new Set(loadJson(getSentDefaultsFile("session1"))),
  session2: new Set(loadJson(getSentDefaultsFile("session2")))
};


// --- Auto Reset Default Message ---
let lastResetTime = null;
function autoResetDefaultMessage() {
  if (resetTimer) clearInterval(resetTimer);
  resetTimer = setInterval(() => {
    for (const sessionId of ["session1", "session2"]) {
      defaultMessageSent[sessionId].clear();
      saveJson(getSentDefaultsFile(sessionId), []);
    }
    lastResetTime = new Date();
    console.log('Default messages reset at', lastResetTime.toLocaleString());
  }, RESET_INTERVAL);
}


// --- Create Electron Window ---
function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 900,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'waweb.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      enableRemoteModule: false,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.setMenu(null);
}

// --- WhatsApp Client Setup ---
let clients = [];
 function createClient(sessionId) {
const c = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.join(SESSION_FOLDER, sessionId)
  }),
  puppeteer: {
    headless: true,
    executablePath: chromePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  }
});

 // --- event handler ---
  c.on('qr', async (qr) => {
    const qrImage = await qrcode.toDataURL(qr);
    win.webContents.send(`qr-${sessionId}`, qrImage);
    win.webContents.send(`qr-status-${sessionId}`, `📷 Scan QR untuk nomor ${sessionId}`);
  });

  c.on('ready', async () => {
  win.webContents.send(`qr-status-${sessionId}`);
  win.webContents.send(`hide-qr-${sessionId}`);

  const jid = c.info.wid._serialized;
  let profilePicUrl = null;
  try {
    profilePicUrl = await c.getProfilePicUrl(jid);
  } catch {}

  const info = {
    user: c.info.wid.user,
    name: c.info.pushname,
    platform: c.info.platform,
    profilePic: profilePicUrl
  };
win.webContents.send(`user-info-${sessionId}`, info);
win.webContents.send(`show-profile-${sessionId}`);

});





  c.on('message', async (msg) => {
  if (msg.from.endsWith('@g.us')) return;

  const sessionId = c.options.authStrategy.dataPath.split(path.sep).pop();
  const text = msg.body.toLowerCase();

  let matched = null;
  for (const k of keywordResponses[sessionId]) {
    if (text.startsWith(k.keyword.toLowerCase())) {
      matched = k;
      break;
    }
  }

  if (matched) {
    const responses = matched.response.split('||').map(r => r.trim()).filter(r => r);
    const finalText = responses.join('\n');
    if (matched.image) {
      const base64Data = matched.image.split(",")[1];
      const mimeType = matched.image.match(/data:(.*);base64/)[1];
      const media = new MessageMedia(mimeType, base64Data);
      await c.sendMessage(msg.from, media, { caption: finalText });
    } else {
      await msg.reply(finalText);
    }
  } else {
    if (!defaultMessageSent[sessionId].has(msg.from) && msg.type === "chat") {
      await msg.reply(defaultMessages[sessionId]);
      defaultMessageSent[sessionId].add(msg.from);
      saveJson(getSentDefaultsFile(sessionId), [...defaultMessageSent[sessionId]]);
    }
  }
});






  c.initialize();
  return c;
}

// --- IPC Handlers ---

ipcMain.handle('add-keyword', (e, { sessionId, data }) => {
  keywordResponses[sessionId].push(data);
  saveJson(getKeywordFile(sessionId), keywordResponses[sessionId]);
  return keywordResponses[sessionId];
});

ipcMain.handle('get-keywords', (e, sessionId) => {
  return keywordResponses[sessionId] || [];
});

ipcMain.handle("get-default-message", (e, sessionId) => defaultMessages[sessionId]);
ipcMain.handle("set-default-message", (e, { sessionId, message }) => {
  defaultMessages[sessionId] = message;
  saveJson(getDefaultMessageFile(sessionId), { message });
  return defaultMessages[sessionId];
});
ipcMain.handle('delete-keyword', (e, { sessionId, index }) => {
  if (keywordResponses[sessionId]) {
    keywordResponses[sessionId].splice(index, 1);
    saveJson(getKeywordFile(sessionId), keywordResponses[sessionId]);
  }
  return keywordResponses[sessionId];
});
ipcMain.handle('edit-keyword', (e, { sessionId, index, data }) => {
  if (keywordResponses[sessionId] && keywordResponses[sessionId][index]) {
    keywordResponses[sessionId][index] = {
      ...keywordResponses[sessionId][index],
      ...data
    };
    saveJson(getKeywordFile(sessionId), keywordResponses[sessionId]);
  }
  return keywordResponses[sessionId];
});


ipcMain.handle('reset-default-message', (e, sessionId) => {
  defaultMessageSent[sessionId].clear();
  saveJson(getSentDefaultsFile(sessionId), []);
  return true;
});


ipcMain.handle('logout', async (e, sessionId) => {
  try {
    const idx = sessionId === "session1" ? 0 : 1;
    if (clients[idx]) {
      await clients[idx].logout();
      await clients[idx].destroy();
    }
    win.webContents.send(`qr-status-${sessionId}`, '🔄 Logout berhasil. Silakan scan QR lagi.');
    win.webContents.send(`hide-profile-${sessionId}`);
    deleteFolderRecursive(path.join(SESSION_FOLDER, sessionId));
    setTimeout(() => {
      defaultMessageSent[sessionId].clear();
      saveJson(getSentDefaultsFile(sessionId), []);
      clients[idx] = createClient(sessionId); // buat ulang
    }, 1000);
  } catch (err) {
    console.error(`❌ Gagal logout ${sessionId}:`, err);
  }
});

// 🔥 Handler untuk custom interval
ipcMain.handle("set-reset-interval", (e, minutes) => {
  RESET_INTERVAL = minutes * 60 * 1000;
  autoResetDefaultMessage();
  console.log(`🔥 Interval reset diubah ke ${minutes} menit`);
  return RESET_INTERVAL;
});

// --- App Lifecycle ---
app.whenReady().then(() => {
  for (const sessionId of ["session1", "session2"]) {
    // inisialisasi file JSON
    if (!fs.existsSync(getKeywordFile(sessionId))) saveJson(getKeywordFile(sessionId), []);
    if (!fs.existsSync(getDefaultMessageFile(sessionId))) saveJson(getDefaultMessageFile(sessionId), { message: "" });
    if (!fs.existsSync(getSentDefaultsFile(sessionId))) saveJson(getSentDefaultsFile(sessionId), []);
    keywordResponses[sessionId] = loadJson(getKeywordFile(sessionId), []);
    const defMsg = loadJson(getDefaultMessageFile(sessionId), { message: "" });
    defaultMessages[sessionId] = defMsg.message || "";
    defaultMessageSent[sessionId] = new Set(loadJson(getSentDefaultsFile(sessionId), []));
  }

  createWindow();

  clients.push(createClient("session1"));
  clients.push(createClient("session2"));

  autoResetDefaultMessage();

  // 🔥 Cek update otomatis
  autoUpdater.checkForUpdatesAndNotify();
});

autoUpdater.on("checking-for-update", () => {
  win.webContents.send("update-message", { status: "🔍 Memeriksa update..." });
});

autoUpdater.on("update-available", () => {
  win.webContents.send("update-message", { status: "🚀 Update baru tersedia, sedang diunduh..." });
});

autoUpdater.on("download-progress", (progress) => {
  win.webContents.send("update-message", { 
    status: `⬇️ Mengunduh update... ${Math.floor(progress.percent)}%`,
    progress: progress.percent
  });
});

autoUpdater.on("update-downloaded", () => {
  win.webContents.send("update-message", { status: "✅ Update siap. Klik 'Restart Sekarang' untuk install.", ready: true });
});
// Tambahkan di bawah autoUpdater.on("update-downloaded", ...)
ipcMain.handle("confirm-update", () => {
  autoUpdater.quitAndInstall();
});

autoUpdater.on("error", (err) => {
  win.webContents.send("update-message", { status: "❌ Gagal update: " + err.message });
});

autoUpdater.on("error", (err) => {
  if (win) {
    win.webContents.send("update-message", "❌ Gagal cek update: " + err.message);
  }
});




app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    console.log("🪟 Re-creating window on activate...");
    createWindow();
  }
});
