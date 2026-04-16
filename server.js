const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { execSync, spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ── In-Memory Cache ───────────────────────────────────────────
const memoryCache = new Map();
const CACHE_TTL = 3 * 60 * 60; // 3 hours (in seconds)

// ── Rate Limiting ─────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// ── Logging Setup ─────────────────────────────────────────────
const logDir = path.join(os.tmpdir(), 'MiGuMusic');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'server.log');

function log(msg, level = 'INFO') {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  console.log(`[MiGu] ${msg}`);
  try { fs.appendFileSync(logFile, line); } catch (e) { }
}

log(`Server process started. Node: ${process.version}, Arch: ${process.arch}`);
log(`Log file: ${logFile}`);

// ── Global Error Handlers ─────────────────────────────────────
process.on('uncaughtException', (err) => {
  log(`Uncaught Exception: ${err.message}`, 'ERROR');
  if (err.stack) log(err.stack, 'ERROR');
});
process.on('unhandledRejection', (reason) => {
  log(`Unhandled Rejection: ${reason}`, 'ERROR');
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve Logo.ico from root directory
app.get('/Logo.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'Logo.ico'));
});

// ── yt-dlp binary path ──────────────────────────────────────────
let ytDlpPath = null;

function findYtDlp() {
  // 1. Check in Electron resources (production) - HIGHEST PRIORITY
  // Check both 'app.asar.unpacked' and 'bin' folder
  if (process.resourcesPath) {
    const paths = [
      path.join(process.resourcesPath, 'bin', 'yt-dlp.exe'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe'),
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) {
        log('[MiGu] Found yt-dlp in production resources: ' + p);
        return p;
      }
    }
  }

  // 2. Check in node_modules (dev) - Only if not in app.asar
  if (!__dirname.includes('app.asar')) {
    const nmPath = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe');
    if (fs.existsSync(nmPath)) {
      log('[MiGu] Found yt-dlp in node_modules (dev)');
      return nmPath;
    }
  }

  // 3. Check system PATH
  try {
    const result = execSync('where yt-dlp', { encoding: 'utf-8' }).trim().split('\n')[0];
    if (result && fs.existsSync(result.trim())) {
      log('[MiGu] Found yt-dlp in system PATH');
      return result.trim();
    }
  } catch (e) { /* not in PATH */ }

  // 4. Check common locations
  const common = [
    path.join(os.homedir(), 'scoop', 'apps', 'yt-dlp', 'current', 'yt-dlp.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'yt-dlp', 'yt-dlp.exe'),
    'C:\\ProgramData\\chocolatey\\bin\\yt-dlp.exe',
  ];
  for (const p of common) {
    if (fs.existsSync(p)) return p;
  }

  console.error('[MiGu] CRITICAL: yt-dlp not found!');
  return null;
}

// ── yt-dlp helper ────────────────────────────────────────────────
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    if (!ytDlpPath) {
      reject(new Error('yt-dlp not found'));
      return;
    }
    log('[MiGu] Executing yt-dlp: ' + args.join(' '));
    const proc = spawn(ytDlpPath, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else {
        log('[MiGu] yt-dlp Error: ' + stderr, 'ERROR');
        reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      }
    });
    proc.on('error', err => {
      log('[MiGu] Spawn Error: ' + err, 'ERROR');
      reject(err);
    });
  });
}

async function runYtDlpWithCookieFallback(baseArgs, targetUrl) {
  // First try without cookies for speed and portability.
  try {
    return await runYtDlp([...baseArgs, targetUrl]);
  } catch (err) {
    const msg = String(err?.message || '');
    const needsAuth =
      msg.includes('Sign in to confirm') ||
      msg.includes('not a bot') ||
      msg.includes('cookies for the authentication');

    if (!needsAuth) throw err;

    log('[MiGu] YouTube requested auth challenge, trying browser cookies fallback...', 'WARN');

    const cookieBrowsers = ['chrome', 'edge', 'firefox'];
    let lastErr = err;
    for (const browser of cookieBrowsers) {
      try {
        log(`[MiGu] Retrying yt-dlp with --cookies-from-browser ${browser}`, 'WARN');
        return await runYtDlp([...baseArgs, '--cookies-from-browser', browser, targetUrl]);
      } catch (cookieErr) {
        lastErr = cookieErr;
      }
    }

    throw lastErr;
  }
}

// ── YouTube Innertube Clients (fallback chain) ───────────────────
const INNERTUBE_CLIENTS = [
  {
    clientName: 'WEB',
    clientVersion: '2.20240101.00.00',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  },
  {
    clientName: 'TVHTML5',
    clientVersion: '7.20240101.00.00',
    userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1'
  },
  {
    clientName: 'ANDROID',
    clientVersion: '19.09.37',
    userAgent: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip'
  },
  {
    clientName: 'MWEB',
    clientVersion: '2.20240101.00.00',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
  },
];

let currentClientIndex = 0;
const YTDLP_EXTRACTOR_ARGS = 'youtube:player_client=tv,android';

function getCurrentClient() {
  return INNERTUBE_CLIENTS[currentClientIndex];
}

function rotateClient() {
  currentClientIndex = (currentClientIndex + 1) % INNERTUBE_CLIENTS.length;
  const c = getCurrentClient();
  log(`[MiGu] Rotated to Innertube client: ${c.clientName}`, 'WARN');
  return c;
}

// ── YouTube Innertube Search (no API key needed) ─────────────────
async function youtubeSearch(query, retries = INNERTUBE_CLIENTS.length) {
  const client = getCurrentClient();
  const url = 'https://www.youtube.com/youtubei/v1/search';
  const body = {
    context: {
      client: {
        clientName: client.clientName,
        clientVersion: client.clientVersion,
        hl: 'vi',
        gl: 'VN'
      }
    },
    query: query,
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': client.userAgent
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    if (retries > 1) { rotateClient(); return youtubeSearch(query, retries - 1); }
    throw e;
  }

  if (!res.ok) {
    log(`[MiGu] Search client ${client.clientName} returned ${res.status}, rotating...`, 'WARN');
    if (retries > 1) { rotateClient(); return youtubeSearch(query, retries - 1); }
    throw new Error(`Search returned ${res.status}`);
  }
  const data = await res.json();

  const results = [];
  try {
    const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents || [];

    for (const section of contents) {
      const items = section.itemSectionRenderer?.contents || [];
      for (const item of items) {
        const v = item.videoRenderer;
        if (!v) continue;

        const durationText = v.lengthText?.simpleText || '0:00';
        const durationParts = durationText.split(':').map(Number);
        let durationSec = 0;
        if (durationParts.length === 3) durationSec = durationParts[0] * 3600 + durationParts[1] * 60 + durationParts[2];
        else if (durationParts.length === 2) durationSec = durationParts[0] * 60 + durationParts[1];

        results.push({
          videoId: v.videoId,
          title: v.title?.runs?.map(r => r.text).join('') || '',
          author: v.ownerText?.runs?.map(r => r.text).join('') || '',
          authorId: v.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '',
          duration: durationSec,
          thumbnail: v.thumbnail?.thumbnails?.pop()?.url || '',
          viewCount: parseInt((v.viewCountText?.simpleText || '0').replace(/[^0-9]/g, '')) || 0,
          published: v.publishedTimeText?.simpleText || ''
        });
      }
    }
  } catch (e) {
    log('[MiGu] Parse error: ' + e.message, 'ERROR');
  }

  return results;
}

// ── Smart recommendations (type + diversity; tránh spam cùng một bài) ──
function stripTitleNoise(title) {
  if (!title) return '';
  const cut = String(title).split(/[|｜/／—–-]{1,}/)[0].trim();
  return cut || String(title).trim();
}

function titleCoreWordSet(title) {
  const core = stripTitleNoise(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return new Set(core.split(/\s+/).filter((w) => w.length > 2));
}

/** Bỏ các bài trùng “cùng ca khúc” khi đang tìm đa dạng */
function titlesTooSimilar(candidateTitle, currentTitle) {
  const aw = titleCoreWordSet(currentTitle);
  const bw = Array.from(titleCoreWordSet(candidateTitle));
  if (aw.size < 4) return false;
  let hit = 0;
  for (const w of bw) if (aw.has(w)) hit++;
  const ratio = hit / aw.size;
  if (ratio >= 0.42) return true;
  const aNorm = stripTitleNoise(currentTitle).toLowerCase().replace(/\s+/g, '');
  const bNorm = stripTitleNoise(candidateTitle).toLowerCase().replace(/\s+/g, '');
  if (aNorm.length >= 14 && bNorm.includes(aNorm.slice(0, 14))) return true;
  return false;
}

function detectSuggestionType(title, author) {
  const text = `${title || ''} ${author || ''}`.toLowerCase();
  const rules = [
    { key: 'remix', label: 'Remix / Trend', patterns: [/\bremix\b/i, /mashup/i, /sped\s*up/i, /speed\s*up/i, /slowed/i, /reverb/i, /nightcore/i, /nhạc\s*remix/i, /\btiktok\b.*mix/i] },
    { key: 'lofi', label: 'Lofi', patterns: [/lofi/i, /lo-fi/i, /lo\s*fi/i, /study\s*beat/i] },
    { key: 'chill', label: 'Chill', patterns: [/\bchill\b/i, /thư\s*giãn/i, /\brelax\b/i] },
    { key: 'cover', label: 'Cover', patterns: [/\bcover\b/i, /acoustic/i, /piano\s*ver/i, /unplugged/i, /bản\s*cover/i] },
    { key: 'karaoke', label: 'Karaoke', patterns: [/karaoke/i, /beat\s*chu[aả]?\s*lời/i] },
    { key: 'rap', label: 'Rap / Trap', patterns: [/\brap\b/i, /\btrap\b/i, /hip\s*hop/i, /drill/i, /\bvn\/?a\s*trap\b/i] },
    { key: 'ballad', label: 'Ballad', patterns: [/ballad/i, /\bbuồn\b/i, /tâm\s*trạng/i, /sầu/i] },
  ];
  for (const r of rules) {
    if (r.patterns.some((p) => p.test(text))) return { key: r.key, label: r.label };
  }
  return { key: 'vpop', label: 'V-Pop' };
}

const TYPE_SEARCH_POOL = {
  remix: ['nhạc remix việt nam hot trend 2025', 'remix tiktok việt nam mới nhất'],
  lofi: ['lofi việt nam chill không lời', 'lofi study việt nam'],
  chill: ['nhạc chill việt nam vibe hot', 'chill playlist việt nam 2025'],
  cover: ['cover acoustic việt nam hay nhất', 'bản cover việt nam viral'],
  karaoke: ['karaoke nhạc trẻ việt nam hot', 'karaoke hit việt nam'],
  rap: ['rap việt hay nhất 2025', 'nhạc trap việt nam mới'],
  ballad: ['nhạc ballad việt nam buồn hay', 'ballad việt nam tâm trạng'],
  vpop: ['vpop mv mới nhất 2025', 'nhạc việt hot trend tháng này'],
};

async function youtubeSearchSafe(query) {
  try {
    return await youtubeSearch(query);
  } catch (e) {
    log('[MiGu] recommend search fail: ' + query + ' — ' + e.message, 'WARN');
    return [];
  }
}

/**
 * @param {'mixed'|'type'|'related'} tab
 */
async function fetchRecommendationsForVideo(videoId, info, tab) {
  const id = String(videoId);
  const title = info.title || '';
  const author = info.author || '';
  const detected = detectSuggestionType(title, author);
  const pools = TYPE_SEARCH_POOL[detected.key] || TYPE_SEARCH_POOL.vpop;

  let raw = [];

  if (tab === 'related') {
    raw = await youtubeSearchSafe(title);
  } else if (tab === 'type') {
    for (const q of pools.slice(0, 2)) {
      const r = await youtubeSearchSafe(q);
      raw.push(...r);
    }
  } else {
    // mixed: thể loại + khám phá V-Pop (đa dạng, không dán title bài hiện tại)
    for (const q of pools.slice(0, 2)) {
      const r = await youtubeSearchSafe(q);
      raw.push(...r);
    }
    const extraPool = TYPE_SEARCH_POOL.vpop;
    const qExtra = extraPool[Math.floor(Math.random() * extraPool.length)];
    raw.push(...(await youtubeSearchSafe(qExtra)));
  }

  const seen = new Set();
  const out = [];
  for (const v of raw) {
    if (!v.videoId || v.videoId === id || seen.has(v.videoId)) continue;
    seen.add(v.videoId);
    if (tab !== 'related' && titlesTooSimilar(v.title, title)) continue;
    out.push(v);
  }

  out.sort((a, b) => (Number(b.viewCount) || 0) - (Number(a.viewCount) || 0));
  const videos = out.slice(0, 14);
  return {
    videos,
    suggestMeta: { tab, typeKey: detected.key, typeLabel: detected.label },
  };
}

// ── YouTube Search Suggestions ───────────────────────────────────
async function youtubeSuggestions(query) {
  const url = `https://suggestqueries-clients6.youtube.com/complete/search?client=youtube&q=${encodeURIComponent(query)}&ds=yt`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  const text = await res.text();
  const jsonStr = text.replace(/^[^(]*\(/, '').replace(/\)$/, '');
  const data = JSON.parse(jsonStr);
  return (data[1] || []).map(item => item[0]);
}

function tokenizeText(input) {
  if (!input) return [];
  return String(input)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

function buildHistoryProfile(history = []) {
  const artistWeight = new Map();
  const tokenWeight = new Map();
  const negativeArtistWeight = new Map();

  for (const h of history) {
    const artist = String(h.author || '').trim().toLowerCase();
    const titleTokens = tokenizeText(h.title || '');
    const listened = Number(h.listenRatio || 0);
    const liked = Boolean(h.liked);
    const skipped = Boolean(h.skippedEarly);

    let weight = 1;
    if (listened > 0.8) weight += 1.4;
    else if (listened > 0.5) weight += 0.8;
    else if (listened < 0.2) weight -= 0.5;
    if (liked) weight += 2;
    if (skipped) weight -= 1.2;

    if (artist) {
      if (weight >= 0) artistWeight.set(artist, (artistWeight.get(artist) || 0) + weight);
      else negativeArtistWeight.set(artist, (negativeArtistWeight.get(artist) || 0) + Math.abs(weight));
    }
    for (const t of titleTokens) {
      tokenWeight.set(t, (tokenWeight.get(t) || 0) + Math.max(0, weight));
    }
  }

  const topArtists = [...artistWeight.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);
  const topTokens = [...tokenWeight.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(e => e[0]);

  return { artistWeight, tokenWeight, negativeArtistWeight, topArtists, topTokens };
}

function scoreCandidate(song, profile, recentIds = new Set()) {
  const artist = String(song.author || '').trim().toLowerCase();
  const tokens = tokenizeText(song.title || '');
  let score = 0;
  const reasons = [];

  const artistAffinity = profile.artistWeight.get(artist) || 0;
  if (artistAffinity > 0) {
    score += Math.min(artistAffinity * 1.8, 8);
    reasons.push(`Bạn hay nghe ${song.author}`);
  }

  const artistPenalty = profile.negativeArtistWeight.get(artist) || 0;
  if (artistPenalty > 0) score -= Math.min(artistPenalty * 1.2, 4);

  let tokenScore = 0;
  for (const t of tokens) tokenScore += profile.tokenWeight.get(t) || 0;
  if (tokenScore > 0) {
    score += Math.min(tokenScore * 0.5, 6);
    if (!reasons.length) reasons.push('Hợp gu gần đây của bạn');
  }

  if (recentIds.has(song.videoId)) score -= 10;
  if (song.viewCount && song.viewCount > 0) score += Math.min(Math.log10(song.viewCount + 1), 3);

  return { score, reason: reasons[0] || 'Đề xuất theo lịch sử nghe' };
}

// ── Cache for stream URLs ────────────────────────────────────────
async function getCachedUrl(videoId) {
  try {
    const cached = memoryCache.get(videoId);
    if (cached && Date.now() - cached.time < CACHE_TTL * 1000) return cached;
    if (cached) memoryCache.delete(videoId);
  } catch (e) { log('Cache Get Error: ' + e.message, 'ERROR'); }
  return null;
}

async function setCachedUrl(videoId, data) {
  try {
    memoryCache.set(videoId, { ...data, time: Date.now() });
  } catch (e) { log('Cache Set Error: ' + e.message, 'ERROR'); }
}

// ── Get audio URL via yt-dlp ─────────────────────────────────────
async function getAudioUrl(videoId) {
  const cached = await getCachedUrl(videoId);
  if (cached) return cached;

  let targetUrl = videoId;
  if (!videoId.startsWith('http')) {
    targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
  }

  const isDirectUrl = videoId.startsWith('http');
  // Avoid m3u8 at all costs, prefer stable progressive audio streams
  const format = isDirectUrl
    ? 'bestaudio[ext=mp3]/bestaudio[ext=m4a]/bestaudio[protocol^=http][protocol!*=m3u8]/bestaudio'
    : 'bestaudio[ext=m4a]/bestaudio[protocol^=http][protocol!*=m3u8]/bestaudio[ext=webm][acodec=opus]/bestaudio[ext=webm]/bestaudio/best';

  log('[MiGu] Extracting for URL: ' + targetUrl);

  const jsonStr = await runYtDlpWithCookieFallback([
    '--no-download',
    '-f', format,
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    '--extractor-retries', '3',
    '--extractor-args', YTDLP_EXTRACTOR_ARGS,
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  ], targetUrl);

  const info = JSON.parse(jsonStr);
  log('[MiGu] Stream URL obtained: ' + (info.url ? 'YES' : 'NO'));
  const result = {
    url: info.url,
    title: info.title || '',
    author: info.uploader || info.channel || '',
    duration: info.duration || 0,
    thumbnail: info.thumbnail || '',
    viewCount: info.view_count || 0,
    time: Date.now()
  };

  await setCachedUrl(videoId, result);
  return result;
}

// ── Get video info via yt-dlp ────────────────────────────────────
async function getVideoInfo(videoId) {
  let targetUrl = videoId;
  if (!videoId.startsWith('http')) {
    targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
  }

  const isDirectUrl = videoId.startsWith('http');
  // Avoid m3u8 at all costs, prefer stable progressive audio streams
  const format = isDirectUrl
    ? 'bestaudio[ext=mp3]/bestaudio[ext=m4a]/bestaudio[protocol^=http][protocol!*=m3u8]/bestaudio'
    : 'bestaudio[ext=m4a]/bestaudio[protocol^=http][protocol!*=m3u8]/bestaudio[ext=webm][acodec=opus]/bestaudio[ext=webm]/bestaudio/best';

  log('[MiGu] Extracting metadata for: ' + targetUrl);

  const jsonStr = await runYtDlpWithCookieFallback([
    '--no-download',
    '-f', format,
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    '--extractor-retries', '3',
    '--extractor-args', YTDLP_EXTRACTOR_ARGS,
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  ], targetUrl);

  const info = JSON.parse(jsonStr);

  // Cache the URL
  const cacheEntry = {
    url: info.url,
    title: info.title || '',
    author: info.uploader || info.channel || '',
    duration: info.duration || 0,
    thumbnail: info.thumbnail || '',
    viewCount: info.view_count || 0,
    time: Date.now()
  };
  await setCachedUrl(videoId, cacheEntry);

  return {
    videoId: videoId,
    title: info.title || '',
    author: info.uploader || info.channel || '',
    duration: info.duration || 0,
    thumbnail: info.thumbnail || '',
    viewCount: info.view_count || 0,
    likeCount: info.like_count || 0,
    streamUrl: info.url,
    proxyStreamUrl: `/api/stream/${encodeURIComponent(videoId)}`,
  };
}

/** Cache metadata khi user đổi tab gợi ý — tránh gọi yt-dlp lặp lại */
const VIDEO_INFO_UI_CACHE = new Map();
async function getVideoInfoCachedForUi(videoId) {
  const row = VIDEO_INFO_UI_CACHE.get(videoId);
  if (row && Date.now() - row.t < 6 * 60 * 1000) return row.info;
  const info = await getVideoInfo(videoId);
  VIDEO_INFO_UI_CACHE.set(videoId, { info, t: Date.now() });
  return info;
}

// ── API: Search ──────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Query "q" is required' });
    const results = await youtubeSearch(q);
    res.json({ results });
  } catch (err) {
    log('[MiGu] Search error: ' + err.message, 'ERROR');
    res.status(500).json({ error: 'Search failed.' });
  }
});

// ── API: Video Info ──────────────────────────────────────────────
app.get('/api/info/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const rawTab = String(req.query.suggest || 'mixed').toLowerCase();
    const suggestTab = ['mixed', 'type', 'related'].includes(rawTab) ? rawTab : 'mixed';
    const info = await getVideoInfoCachedForUi(id);

    let recommended = [];
    let suggestMeta = { tab: suggestTab, typeKey: 'vpop', typeLabel: 'V-Pop' };
    try {
      const pack = await fetchRecommendationsForVideo(id, info, suggestTab);
      recommended = pack.videos;
      suggestMeta = pack.suggestMeta;
    } catch (e) { /* silent */ }

    res.json({
      ...info,
      recommendedVideos: recommended,
      suggestMeta,
    });
  } catch (err) {
    log('[MiGu] Info error: ' + err.message, 'ERROR');
    res.status(500).json({ error: 'Failed to get video info.' });
  }
});

// ── API: Playlist Info ───────────────────────────────────────────
app.get('/api/playlist-info/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { v } = req.query; // Optional video ID for context (Mixes)

    let targetUrl = `https://www.youtube.com/playlist?list=${id}`;
    if (id.startsWith('RD') && v) {
      targetUrl = `https://www.youtube.com/watch?v=${v}&list=${id}`;
    }

    // --flat-playlist gives us metadata quickly without analyzing every video's stream
    // --playlist-items 1-15 limits the results
    const jsonStr = await runYtDlp([
      '--flat-playlist',
      '--dump-json',
      '--playlist-items', '1-15',
      '--no-warnings',
      targetUrl
    ]);

    // yt-dlp outputs one JSON object per line for a flat playlist
    const items = jsonStr.split('\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          const info = JSON.parse(line);
          return {
            videoId: info.id || info.url || '',
            title: info.title || 'Untitled',
            author: info.uploader || info.channel || '',
            duration: info.duration || 0,
            thumbnail: `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`
          };
        } catch (e) { return null; }
      })
      .filter(item => item && item.videoId);

    res.json({ playlistId: id, items });
  } catch (err) {
    log('[MiGu] Playlist info error: ' + err.message, 'ERROR');
    res.status(500).json({ error: 'Failed to fetch playlist info.' });
  }
});

// ── API: Prefetch stream URL (warm memory cache — faster handoff to next track)
app.get('/api/prefetch/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await getAudioUrl(id);
    res.status(204).end();
  } catch (err) {
    log('[MiGu] Prefetch error: ' + err.message, 'WARN');
    res.status(204).end();
  }
});

// ── API: Audio Stream Proxy ──────────────────────────────────────
app.get('/api/stream/:id', async (req, res) => {
  try {
    const { id } = req.params;
    log('[MiGu] Stream Proxy Request for ID: ' + id);
    const audioInfo = await getAudioUrl(id);

    if (!audioInfo.url) {
      log('[MiGu] No stream URL for ID: ' + id, 'ERROR');
      return res.status(404).json({ error: 'No audio stream found' });
    }

    log('[MiGu] Proxying remote stream: ' + audioInfo.url.substring(0, 100) + '...');

    // Proxy the audio stream
    const streamUrl = String(audioInfo.url || '');
    const isYouTubeStream =
      streamUrl.includes('googlevideo.com') ||
      streamUrl.includes('youtube.com') ||
      streamUrl.includes('youtu.be');
    const isSoundCloudStream = streamUrl.includes('soundcloud.com') || streamUrl.includes('sndcdn.com');

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Connection': 'keep-alive',
      'Accept': '*/*',
      'Accept-Encoding': 'identity'
    };
    if (isYouTubeStream) {
      headers['Referer'] = 'https://www.youtube.com/';
      headers['Origin'] = 'https://www.youtube.com';
    } else if (isSoundCloudStream) {
      headers['Referer'] = 'https://soundcloud.com/';
      headers['Origin'] = 'https://soundcloud.com';
    }
    const requestedRange = String(req.headers.range || '');
    if (requestedRange) headers['Range'] = requestedRange;

    // Do not use short fetch timeout for long music streams.
    // A 15s timeout often aborts mid-track on unstable networks.
    let audioRes = await fetch(audioInfo.url, { headers });
    const contentType = audioRes.headers.get('content-type') || '';
    const isHLS = contentType.includes('mpegurl') || audioInfo.url.includes('.m3u8');

    if (isHLS) {
      log('[MiGu] Detected HLS/M3U8. Re-streaming via yt-dlp for stability...');
      if (audioRes.body.destroy) audioRes.body.destroy();

      res.setHeader('Content-Type', 'audio/mpeg');
      const proc = spawn(ytDlpPath, ['-o', '-', '-f', 'bestaudio', '--no-playlist', '--no-warnings', id], { windowsHide: true });
      proc.stdout.pipe(res);
      proc.on('close', (code) => log('[MiGu] HLS Stream Process closed with code ' + code));
      return;
    }

    log(`[MiGu] Remote Status: ${audioRes.status} | Content-Type: ${contentType}`);
    res.status(audioRes.status);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Connection', 'keep-alive');

    // Forward all relevant headers
    const fwd = ['content-type', 'content-length', 'content-range', 'cache-control', 'expires'];
    for (const h of fwd) {
      const v = audioRes.headers.get(h);
      if (v) {
        if (h === 'content-type') log(`[MiGu] Mime-Type: ${v}`);
        res.set(h, v);
      }
    }

    let bytesForwarded = 0;
    let reconnectAttempts = 0;
    let streamClosed = false;
    let reconnecting = false;

    const parseRangeStart = (rangeHeader) => {
      const m = /^bytes=(\d+)-/i.exec(String(rangeHeader || '').trim());
      return m ? Number(m[1]) : 0;
    };
    const rangeStart = parseRangeStart(requestedRange);

    const attachStream = (upstream, isReconnect = false) => {
      if (!upstream || !upstream.body) return;
      upstream.body.on('data', (chunk) => {
        bytesForwarded += Buffer.byteLength(chunk);
      });
      upstream.body.on('error', async (err) => {
        log('[MiGu] Stream Body Error: ' + err.message, 'ERROR');
        if (streamClosed || res.writableEnded || reconnectAttempts >= 2) return;
        reconnectAttempts++;
        const resumeFrom = rangeStart + bytesForwarded;
        const retryHeaders = { ...headers, Range: `bytes=${resumeFrom}-` };
        log(`[MiGu] Reconnecting upstream stream from byte ${resumeFrom} (attempt ${reconnectAttempts})`, 'WARN');
        reconnecting = true;
        try {
          const retryRes = await fetch(audioInfo.url, { headers: retryHeaders });
          if (!retryRes.ok || !retryRes.body) {
            log(`[MiGu] Reconnect failed with status ${retryRes.status}`, 'ERROR');
            reconnecting = false;
            return;
          }
          audioRes = retryRes;
          reconnecting = false;
          attachStream(retryRes, true);
        } catch (reErr) {
          reconnecting = false;
          log('[MiGu] Reconnect stream error: ' + reErr.message, 'ERROR');
        }
      });
      upstream.body.on('end', () => {
        if (streamClosed || res.writableEnded) return;
        setTimeout(() => {
          if (!reconnecting && !res.writableEnded) res.end();
        }, 120);
      });
      upstream.body.pipe(res, { end: false }).on('error', (err) => {
        log('[MiGu] Response Pipe Error: ' + err.message, 'ERROR');
      });
      if (isReconnect) {
        log('[MiGu] Upstream stream reattached successfully', 'WARN');
      }
    };

    res.on('close', () => {
      streamClosed = true;
      try { if (audioRes?.body?.destroy) audioRes.body.destroy(); } catch (_) { /* ignore */ }
    });

    attachStream(audioRes);
  } catch (err) {
    log('[MiGu] Stream Proxy Error: ' + err.message, 'ERROR');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to proxy stream.' });
    }
  }
});

// ── API: Search Suggestions ──────────────────────────────────────
app.get('/api/suggest', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json([]);
    const suggestions = await youtubeSuggestions(q);
    res.json(suggestions);
  } catch (err) {
    res.json([]);
  }
});

// ── API: Trending Music ──────────────────────────────────────────
/** Tab keys → search query pools (Innertube search, not official “Trending” charts). */
const TRENDING_CATEGORY_QUERIES = {
  chill: ['nhạc chill việt nam hot', 'chill playlist việt nam 2026'],
  lofi: ['lofi việt nam study', 'lofi chill beats không lời'],
  remix: ['nhạc remix việt nam hot trend', 'remix tiktok việt nam'],
  mv: ['MV mới ra mắt việt nam', 'mv official việt nam mới'],
};

app.get('/api/trending', async (req, res) => {
  try {
    const cat = String(req.query.category || 'all').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    let query;

    if (cat === 'all' || cat === '') {
      const queries = [
        'nhạc chill vietnam 2026',
        'MV mới ra mắt',
        'top hits vietnam'
      ];
      query = queries[Math.floor(Math.random() * queries.length)];
    } else {
      const pool = TRENDING_CATEGORY_QUERIES[cat];
      if (!pool) {
        return res.status(400).json({ error: 'Unknown trending category.' });
      }
      query = pool[Math.floor(Math.random() * pool.length)];
    }

    const results = await youtubeSearch(query);
    res.json({ results: results.slice(0, 12), category: cat || 'all' });
  } catch (err) {
    log('[MiGu] Trending error: ' + err.message, 'ERROR');
    res.status(500).json({ error: 'Failed to get trending.' });
  }
});

// ── API: Personalized Recommendations (free, rule-based) ───────
app.post('/api/recommend', async (req, res) => {
  try {
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-50) : [];
    if (history.length === 0) {
      return res.json({ results: [], source: 'empty-history' });
    }

    const profile = buildHistoryProfile(history);
    const recentIds = new Set(history.slice(-20).map(h => h.videoId).filter(Boolean));
    const seen = new Set(recentIds);
    const pool = [];

    const trending = await youtubeSearch('nhạc thịnh hành việt nam');
    for (const s of trending.slice(0, 18)) {
      if (!seen.has(s.videoId)) {
        seen.add(s.videoId);
        pool.push(s);
      }
    }

    const queries = [];
    if (profile.topArtists.length > 0) queries.push(...profile.topArtists.slice(0, 3));
    if (profile.topTokens.length > 2) queries.push(profile.topTokens.slice(0, 3).join(' '));
    if (queries.length === 0) queries.push('nhạc chill');

    for (const q of queries.slice(0, 4)) {
      try {
        const results = await youtubeSearch(q);
        for (const s of results.slice(0, 8)) {
          if (!seen.has(s.videoId)) {
            seen.add(s.videoId);
            pool.push(s);
          }
        }
      } catch (_) { }
    }

    const ranked = pool
      .map(song => {
        const scored = scoreCandidate(song, profile, recentIds);
        return { ...song, score: Number(scored.score.toFixed(3)), reason: scored.reason };
      })
      .filter(s => s.score > -2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 14);

    res.json({ results: ranked, source: 'rule-based' });
  } catch (err) {
    log('[MiGu] Recommend error: ' + err.message, 'ERROR');
    res.status(500).json({ error: 'Failed to build recommendations.' });
  }
});

// ── API: Health Check ───────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.2.3',
    ytDlp: !!ytDlpPath,
    ytDlpPath: ytDlpPath ? 'Found' : 'Missing',
    uptime: process.uptime(),
    currentClient: getCurrentClient().clientName,
    clientIndex: currentClientIndex,
    totalClients: INNERTUBE_CLIENTS.length
  });
});

// ── API: Rotate Innertube Client ─────────────────────────────────
app.post('/api/rotate-client', (req, res) => {
  const client = rotateClient();
  res.json({ success: true, client: client.clientName, index: currentClientIndex });
});

// ── SPA Fallback ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start Server ─────────────────────────────────────────────────
ytDlpPath = findYtDlp();

// Verify yt-dlp is actually functional
if (ytDlpPath) {
  runYtDlp(['--version'])
    .then(v => log(`yt-dlp version: ${v}`))
    .catch(err => log(`yt-dlp verification failed: ${err.message}`, 'ERROR'));
}

const server = app.listen(PORT, () => {
  log(`
  ╔══════════════════════════════════════╗
  ║     🎵  MiGu Music Server v2.0      ║
  ║     http://localhost:${PORT}            ║
  ╚══════════════════════════════════════╝
  yt-dlp: ${ytDlpPath || '❌ NOT FOUND'}
  `);
});

module.exports = server;
