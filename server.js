const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { execSync, spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

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
  // 1. Check in node_modules
  const nmPath = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe');
  if (fs.existsSync(nmPath)) return nmPath;

  // 2. Check system PATH
  try {
    const result = execSync('where yt-dlp', { encoding: 'utf-8' }).trim().split('\n')[0];
    if (result && fs.existsSync(result.trim())) return result.trim();
  } catch (e) { /* not in PATH */ }

  // 3. Check common locations
  const common = [
    path.join(os.homedir(), 'scoop', 'apps', 'yt-dlp', 'current', 'yt-dlp.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'yt-dlp', 'yt-dlp.exe'),
    'C:\\ProgramData\\chocolatey\\bin\\yt-dlp.exe',
  ];
  for (const p of common) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

// ── yt-dlp helper ────────────────────────────────────────────────
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    if (!ytDlpPath) {
      reject(new Error('yt-dlp not found'));
      return;
    }
    const proc = spawn(ytDlpPath, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `yt-dlp exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

// ── YouTube Innertube Search (no API key needed) ─────────────────
async function youtubeSearch(query) {
  const url = 'https://www.youtube.com/youtubei/v1/search';
  const body = {
    context: {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20240101.00.00',
        hl: 'vi',
        gl: 'VN'
      }
    },
    query: query,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(`Search returned ${res.status}`);
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
    console.error('[MiGu] Parse error:', e.message);
  }

  return results;
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

// ── Cache for stream URLs ────────────────────────────────────────
const streamCache = new Map();
const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours

function getCachedUrl(videoId) {
  const cached = streamCache.get(videoId);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return cached;
  }
  streamCache.delete(videoId);
  return null;
}

// ── Get audio URL via yt-dlp ─────────────────────────────────────
async function getAudioUrl(videoId) {
  const cached = getCachedUrl(videoId);
  if (cached) return cached;

  const jsonStr = await runYtDlp([
    '--no-download',
    // Prefer: Opus 160kbps > any opus/webm > best audio available
    '-f', 'bestaudio[ext=webm][acodec=opus][abr>=160]/bestaudio[ext=webm][acodec=opus]/bestaudio[ext=webm]/bestaudio',
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    '--extractor-retries', '3',
    `https://www.youtube.com/watch?v=${videoId}`
  ]);

  const info = JSON.parse(jsonStr);
  const result = {
    url: info.url,
    title: info.title || '',
    author: info.uploader || info.channel || '',
    duration: info.duration || 0,
    thumbnail: info.thumbnail || '',
    viewCount: info.view_count || 0,
    time: Date.now()
  };

  streamCache.set(videoId, result);
  return result;
}

// ── Get video info via yt-dlp ────────────────────────────────────
async function getVideoInfo(videoId) {
  const jsonStr = await runYtDlp([
    '--no-download',
    '-f', 'bestaudio',
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    `https://www.youtube.com/watch?v=${videoId}`
  ]);

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
  streamCache.set(videoId, cacheEntry);

  return {
    videoId: videoId,
    title: info.title || '',
    author: info.uploader || info.channel || '',
    duration: info.duration || 0,
    thumbnail: info.thumbnail || '',
    viewCount: info.view_count || 0,
    likeCount: info.like_count || 0,
    streamUrl: info.url,
    proxyStreamUrl: `/api/stream/${videoId}`,
  };
}

// ── API: Search ──────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Query "q" is required' });
    const results = await youtubeSearch(q);
    res.json({ results });
  } catch (err) {
    console.error('[MiGu] Search error:', err.message);
    res.status(500).json({ error: 'Search failed.' });
  }
});

// ── API: Video Info ──────────────────────────────────────────────
app.get('/api/info/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const info = await getVideoInfo(id);

    // Also search for related videos using the title
    let recommended = [];
    try {
      const related = await youtubeSearch(info.title);
      recommended = related.filter(r => r.videoId !== id).slice(0, 8);
    } catch (e) { /* silent */ }

    res.json({
      ...info,
      recommendedVideos: recommended
    });
  } catch (err) {
    console.error('[MiGu] Info error:', err.message);
    res.status(500).json({ error: 'Failed to get video info.' });
  }
});

// ── API: Audio Stream Proxy ──────────────────────────────────────
app.get('/api/stream/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const audioInfo = await getAudioUrl(id);

    if (!audioInfo.url) {
      return res.status(404).json({ error: 'No audio stream found' });
    }

    // Proxy the audio stream
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const audioRes = await fetch(audioInfo.url, { headers });

    res.status(audioRes.status);
    const fwdHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
    for (const h of fwdHeaders) {
      const v = audioRes.headers.get(h);
      if (v) res.set(h, v);
    }

    audioRes.body.pipe(res);
  } catch (err) {
    console.error('[MiGu] Stream error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Stream failed.' });
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
app.get('/api/trending', async (req, res) => {
  try {
    // Use search-based approach for reliable trending content
    const queries = [
      'nhạc trending vietnam 2026',
      'nhạc hot tiktok mới nhất',
      'top hits vietnam'
    ];
    const query = queries[Math.floor(Math.random() * queries.length)];
    const results = await youtubeSearch(query);
    res.json({ results: results.slice(0, 12) });
  } catch (err) {
    console.error('[MiGu] Trending error:', err.message);
    res.status(500).json({ error: 'Failed to get trending.' });
  }
});

// ── SPA Fallback ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start Server ─────────────────────────────────────────────────
ytDlpPath = findYtDlp();

const server = app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║     🎵  MiGu Music Server v2.0      ║
  ║     http://localhost:${PORT}            ║
  ╚══════════════════════════════════════╝
  yt-dlp: ${ytDlpPath || '❌ NOT FOUND - run: npm install youtube-dl-exec'}
  `);
});

module.exports = server;
