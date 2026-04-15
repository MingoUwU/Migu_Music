/* ═══════════════════════════════════════════════════════════════
   MiGu Music Player v2.1.8 — iOS 26 Liquid Glass Edition
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────
  const state = {
    currentView: 'home',
    queue: [],
    currentIndex: -1,
    isPlaying: false,
    shuffle: false,
    repeat: 'off',
    volume: 100,
    favorites: [],
    playlists: {},
    idleTimer: null,
    idleTimeout: 60000,
    searchDebounce: null,
    currentSongInfo: null,
    roomQueue: [],
    activeQueueTab: 'personal',
    listeningHistory: [],
    activeListenSession: null,
    lowPerformanceMode: false,
    superSaverMode: false,
    lastVisualizerFrameAt: 0,
    trendingCategory: 'all',
    communityChartSongs: [],
    /** Gợi ý theo bài đang/ vừa phát — dùng autoplay khi hết hàng chờ */
    lastRecommendationVideos: [],
    /** Tab gợi ý NP: mixed | type | related */
    activeSuggestTab: 'mixed',
  };

  let socket = null;
  let roomCode = null;
  let isRoomHost = false;
  let isProcessingRoomSync = false;
  let syncHeartbeat = null;
  /** Guest: chờ seek sau metadata — nội suy từ mốc host (syncAnchorAt / syncAudioTime). */
  let pendingHostSyncSeek = null;
  let lastHostEmitAt = 0;
  let myRoomJoinedAt = Date.now();

  const ROOM_TICK_MS = 12000;
  const ROOM_TICK_MS_SUPER = 20000;
  const HOST_EMIT_DEBOUNCE_MS = 320;

  /** Vị trí phát host tại “bây giờ” từ mốc thời gian — giảm phụ thuộc gói currentTime lặp lại. */
  function getEffectiveHostPlaybackTime(u) {
    if (!u) return 0;
    const at = Number(u.syncAnchorAt);
    const t0 = Number(u.syncAudioTime);
    if (Number.isFinite(at) && Number.isFinite(t0)) {
      if (u.isPlaying === false) return Math.max(0, t0);
      return Math.max(0, t0 + (Date.now() - at) / 1000);
    }
    const ct = Number(u.currentTime);
    return Number.isFinite(ct) ? Math.max(0, ct) : 0;
  }

  const SUPABASE_URL = 'https://jhuqonoldshtxsquurho.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_ANl0zKdVePo8bAE_B8qKWA_bZOV5BvL';
  let supabase = null;
  let roomChannel = null;
  const myUserId = 'user_' + Math.random().toString(36).substr(2, 9);

  // Public Rooms & Sync Prompt State
  let globalLobbyChannel = null;
  let activePublicRooms = [];
  let userSyncChoice = null;
  let hasShownSyncPrompt = false;

  // Public Rooms & Sync Prompt State

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const audio = $('#audio-player');

  /** Next/prev/end-of-track navigation: host uses room queue, everyone else uses personal queue. */
  function getActivePlaybackQueue() {
    if (roomCode && isRoomHost) return state.roomQueue;
    return state.queue;
  }

  /** Bài kế trong hàng chờ (thứ tự tuần tự, không shuffle) — dùng prefetch URL. */
  function getNextSongAfterCurrent() {
    const q = getActivePlaybackQueue();
    if (!q.length || state.currentIndex < 0) return null;
    if (state.shuffle) return null;
    const i = state.currentIndex;
    if (i < q.length - 1) return q[i + 1];
    if (state.repeat === 'all' && q.length > 0) return q[0];
    return null;
  }

  let nextStreamPrefetchVideoId = null;
  let endStallNudgeCount = 0;

  /** Gọi server warm cache yt-dlp cho bài kế — giảm đứng 5–10s khi chuyển bài. */
  function tryPrefetchNextTrackUrl() {
    const next = getNextSongAfterCurrent();
    if (!next?.videoId) return;
    if (nextStreamPrefetchVideoId === next.videoId) return;
    nextStreamPrefetchVideoId = next.videoId;
    fetch(`/api/prefetch/${encodeURIComponent(next.videoId)}`, { method: 'GET', cache: 'no-store' }).catch(() => { });
  }

  /** Hard seek only when very far off (rare); softer path uses playbackRate. */
  let lastDriftCorrectionAt = 0;
  let syncPlaybackRateResetTimer = null;

  function resetGuestSyncPlaybackRate() {
    if (syncPlaybackRateResetTimer) {
      clearTimeout(syncPlaybackRateResetTimer);
      syncPlaybackRateResetTimer = null;
    }
    try {
      if (audio) audio.playbackRate = 1;
    } catch (_) { /* ignore */ }
  }

  function scheduleGuestPlaybackRateReset(ms = 4500) {
    if (syncPlaybackRateResetTimer) clearTimeout(syncPlaybackRateResetTimer);
    syncPlaybackRateResetTimer = setTimeout(() => {
      syncPlaybackRateResetTimer = null;
      try {
        if (audio) audio.playbackRate = 1;
      } catch (_) { /* ignore */ }
    }, ms);
  }

  let guestAutoplayUnlockHandler = null;
  const HOME_SECTION_TTL_MS = 15 * 60 * 1000; // 15 minutes
  const SAVE_STATE_DEBOUNCE_MS = 500;
  const MAX_QUEUE_ITEMS = 200;
  const MAX_FAVORITES_ITEMS = 500;
  const MAX_PLAYLIST_ITEMS = 300;
  const MAX_RECOMMENDATION_ITEMS = 20;
  const MAX_COMMUNITY_CHART_ITEMS = 20;
  const SUPER_QUEUE_RENDER_LIMIT = 60;
  const SUPER_ROOM_QUEUE_RENDER_LIMIT = 40;
  const SUPER_FAVORITES_RENDER_LIMIT = 80;
  const SUPER_TRENDING_RENDER_LIMIT = 6;
  const homeTrendingCache = new Map(); // key: category -> { rows, t }
  const homeTrendingInFlight = new Map(); // key: category -> Promise
  let homeCommunityCache = null; // { rows, t }
  let homeCommunityInFlight = null;
  let homePersonalizedCache = null; // { rows, t, sig }
  let homePersonalizedInFlight = null;
  let saveStateTimer = null;

  function isFreshHomeCache(row) {
    return !!(row && (Date.now() - Number(row.t || 0) < HOME_SECTION_TTL_MS));
  }

  function getHistorySignature() {
    const hist = Array.isArray(state.listeningHistory) ? state.listeningHistory : [];
    return hist.slice(-50).map(h => `${h.videoId || ''}:${Number(h.listenRatio || 0).toFixed(2)}:${h.liked ? 1 : 0}`).join('|');
  }

  function normalizeSongEntry(song) {
    if (!song || !song.videoId) return null;
    return {
      videoId: String(song.videoId),
      title: String(song.title || ''),
      author: String(song.author || ''),
      thumbnail: String(song.thumbnail || ''),
      duration: Number(song.duration) || 0,
    };
  }

  function getWindowedEntries(list, currentIndex, maxItems) {
    const arr = Array.isArray(list) ? list : [];
    if (!maxItems || arr.length <= maxItems) {
      return arr.map((item, index) => ({ item, index }));
    }

    const safeCurrent = Number.isFinite(currentIndex) ? currentIndex : 0;
    const half = Math.floor(maxItems / 2);
    let start = Math.max(0, safeCurrent - half);
    let end = start + maxItems;
    if (end > arr.length) {
      end = arr.length;
      start = Math.max(0, end - maxItems);
    }
    return arr.slice(start, end).map((item, i) => ({ item, index: start + i }));
  }

  function enforceStateLimits() {
    state.queue = (Array.isArray(state.queue) ? state.queue : [])
      .map(normalizeSongEntry)
      .filter(Boolean)
      .slice(-MAX_QUEUE_ITEMS);

    state.favorites = (Array.isArray(state.favorites) ? state.favorites : [])
      .map(normalizeSongEntry)
      .filter(Boolean)
      .slice(0, MAX_FAVORITES_ITEMS);

    const playlists = (state.playlists && typeof state.playlists === 'object') ? state.playlists : {};
    const normalizedPlaylists = {};
    Object.entries(playlists).forEach(([name, songs]) => {
      normalizedPlaylists[name] = (Array.isArray(songs) ? songs : [])
        .map(normalizeSongEntry)
        .filter(Boolean)
        .slice(0, MAX_PLAYLIST_ITEMS);
    });
    state.playlists = normalizedPlaylists;

    state.lastRecommendationVideos = (Array.isArray(state.lastRecommendationVideos) ? state.lastRecommendationVideos : [])
      .slice(0, MAX_RECOMMENDATION_ITEMS);
    state.communityChartSongs = (Array.isArray(state.communityChartSongs) ? state.communityChartSongs : [])
      .slice(0, MAX_COMMUNITY_CHART_ITEMS);
  }
  function clearGuestAutoplayUnlock() {
    if (guestAutoplayUnlockHandler) {
      document.removeEventListener('pointerdown', guestAutoplayUnlockHandler, true);
      guestAutoplayUnlockHandler = null;
    }
  }

  /**
   * Autoplay bị chặn: không bắt bấm Play trên thanh điều khiển (guest đang bị disable).
   * Lần chạm/chuột đầu tiên trên app sẽ gọi audio.play() để nối vào luồng host.
   */
  function scheduleGuestAutoplayUnlock() {
    if (!roomCode || isRoomHost || guestAutoplayUnlockHandler) return;
    guestAutoplayUnlockHandler = () => {
      if (!roomCode || isRoomHost) {
        clearGuestAutoplayUnlock();
        return;
      }
      audio
        .play()
        .then(() => {
          clearGuestAutoplayUnlock();
          state.isPlaying = true;
          updatePlayBtns(true);
        })
        .catch(() => {});
    };
    document.addEventListener('pointerdown', guestAutoplayUnlockHandler, { capture: true });
  }

  const SVG = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
  };

  // ── Permissions ───────────────────────────────────────────────
  function applyHostPermissions() {
    const isGuest = roomCode && !isRoomHost;
    const seekOk = canScrubTimeline();

    const transportSelectors = [
      '#np-btn-play', '#np-btn-prev', '#np-btn-next',
      '#np-btn-shuffle', '#np-btn-repeat',
      '#pb-play', '#pb-prev', '#pb-next',
      '#room-btn-play', '#room-btn-prev', '#room-btn-next',
    ];

    transportSelectors.forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      if (isGuest) {
        el.style.pointerEvents = 'none';
        el.style.opacity = '0.35';
      } else {
        el.style.pointerEvents = 'auto';
        el.style.opacity = '1';
      }
    });

    ['#np-progress-bar', '#pb-progress'].forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      if (!seekOk) {
        el.style.pointerEvents = 'none';
        el.style.opacity = isGuest ? '0.35' : '1';
        el.title =
          'Trong phòng không tua thanh — dùng Next/Prev và Play (host). Tránh spam vị trí, lag cả phòng.';
      } else {
        el.style.pointerEvents = 'auto';
        el.style.opacity = '1';
        el.removeAttribute('title');
      }
    });

    const rqc = $('#room-queue-container');
    // We purposefully DO NOT disable pointer events on rqc so guests can interact with queue items!
  }

  // ── Greeting ──────────────────────────────────────────────────
  function setGreeting() {
    const hour = new Date().getHours();
    let text = 'Xin chào';
    let sub = 'Bắt đầu ngày mới với âm nhạc';

    if (hour >= 5 && hour < 11) {
      text = 'Chào buổi sáng! ';
      sub = 'Bắt đầu ngày mới tràn đầy năng lượng';
    } else if (hour >= 11 && hour < 14) {
      text = 'Chào buổi trưa! ';
      sub = 'Thư giãn một chút với âm nhạc nhé';
    } else if (hour >= 14 && hour < 18) {
      text = 'Chào buổi chiều! ';
      sub = 'Tiếp thêm cảm hứng cho buổi chiều';
    } else {
      text = 'Chào buổi tối! ';
      sub = 'Thả lỏng cơ thể cùng những giai điệu yêu thích';
    }

    const h2 = $('#greeting-text');
    const p = $('#greeting-sub');
    if (h2) h2.textContent = text;
    if (p) p.textContent = sub;
  }

  // ── Init ──────────────────────────────────────────────────────
  async function checkServer() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      if (data.status === 'ok') {
        if (!data.ytDlp) {
          toast('Cảnh báo: Không tìm thấy trình phát nhạc (yt-dlp)', 'error');
        }
        console.log(`[MiGu] Server OK | Client: ${data.currentClient} (${data.clientIndex + 1}/${data.totalClients})`);
      }
    } catch (e) {
      console.error('[MiGu] Server health check failed');
      toast('Không thể kết nối đến máy chủ âm nhạc', 'error');
    }
  }

  function init() {
    detectPerformanceMode();
    checkServer();
    loadState();
    setupPerformanceToggle();
    setupParticles();
    setupNavigation();
    setupSearch();
    setupPasteLink();
    setupPlayerControls();
    setupVolumeControls();
    setupKeyboardShortcuts();
    setupIdleDetection();
    setupModals();
    setupElectronUpdaterUI();
    if (window.electronAPI?.onUpdateMsg) {
      window.electronAPI.onUpdateMsg((msg) => toast(msg, 'info'));
    }
    setupMediaSession();
    setupQueueTabs();
    setupRoom(); // Initialize socket
    setupVisualizer(); // Initialize Web Audio API
    setupTrendingTabs();
    setupSuggestTabs();
    setupNpPanelSplitter();
    setupCommunityChartPlayAll();
    loadTrending();
    loadCommunityChart();
    loadPersonalizedRecommendations();
    renderPlaylists();
    setGreeting();
    audio.volume = state.volume / 100;
    $('#fav-count').textContent = state.favorites.length;

    // Allow manual update check by clicking version label
    const ver = $('.logo-version');
    if (ver) {
      ver.style.cursor = 'pointer';
      ver.title = 'Click để kiểm tra cập nhật';
      ver.addEventListener('click', () => {
        toast('Đang kiểm tra cập nhật...', 'info');
        window.electronAPI?.checkUpdate?.();
      });
    }

    if (state.queue && state.queue.length > 0) {
      renderQueue();
      if (state.currentIndex >= 0 && state.currentIndex < state.queue.length) {
        const song = state.queue[state.currentIndex];
        state.currentSongInfo = song;
        updateUI(song);
        audio.src = `/api/stream/${song.videoId}`;
        audio.load();
        showBar(true);
      }
    }

    // Signal renderer ready so updater can start check.
    setTimeout(() => {
      window.electronAPI?.signalReady?.();
    }, 120);

    window.addEventListener('beforeunload', () => {
      if (saveStateTimer) {
        clearTimeout(saveStateTimer);
        saveStateTimer = null;
      }
      persistStateNow();
    });
  }

  function detectPerformanceMode() {
    const memory = Number(navigator.deviceMemory || 8);
    const cores = Number(navigator.hardwareConcurrency || 4);
    state.lowPerformanceMode = (memory <= 8) || (cores <= 4);

    if (state.lowPerformanceMode) {
      console.log(`[MiGu] Low performance mode ON (RAM:${memory}GB, CPU cores:${cores})`);
    }
  }

  function isSuperMode() {
    return !!state.superSaverMode;
  }

  function setupPerformanceToggle() {
    const btn = $('#btn-super-mode');
    if (!btn) return;

    const superMeta = btn.querySelector('[data-super-meta]');

    const refreshLabel = () => {
      const on = isSuperMode();
      btn.classList.toggle('is-active', on);
      if (superMeta) {
        superMeta.textContent = on
          ? 'Đang bật · gợi ý & hiệu ứng tắt'
          : 'Tắt — nhấn để tiết kiệm RAM/CPU';
      }
    };

    refreshLabel();
    btn.addEventListener('click', () => {
      state.superSaverMode = !state.superSaverMode;
      saveState();
      refreshLabel();
      setupParticles();

      // Reset UI elements impacted by super mode
      const suggest = $('#suggest-container');
      if (suggest && state.superSaverMode) {
        suggest.innerHTML = '<div class="empty-state small"><p>Đã tắt gợi ý để tiết kiệm hiệu năng</p></div>';
      }
      const rec = $('#recommended-container');
      if (rec && state.superSaverMode) {
        rec.innerHTML = '<div class="empty-state small" style="grid-column: 1 / -1;"><p>Super mode: tắt gợi ý cá nhân</p></div>';
      }
      const chart = $('#community-chart-container');
      const chartBtn = $('#btn-play-community-chart');
      if (state.superSaverMode) {
        if (chart) {
          chart.innerHTML = '<div class="empty-state small" style="grid-column: 1 / -1;"><p>Super mode: ẩn Top nghe nhiều để tiết kiệm hiệu năng</p></div>';
        }
        if (chartBtn) chartBtn.style.display = 'none';
      }

      toast(state.superSaverMode ? 'Đã bật Super tiết kiệm' : 'Đã tắt Super tiết kiệm', 'info');
      if (state.superSaverMode && state.currentView === 'nowplaying') {
        switchView('home');
      }
      if (syncHeartbeat) {
        clearInterval(syncHeartbeat);
        syncHeartbeat = setInterval(() => {
          if (isRoomHost && roomChannel && roomCode) emitRoomPlaybackTick();
        }, state.superSaverMode ? ROOM_TICK_MS_SUPER : ROOM_TICK_MS);
      }
      if (!state.superSaverMode) {
        loadPersonalizedRecommendations({ preferCache: true });
      }
    });
  }

  // ── Persistence ───────────────────────────────────────────────
  function loadState() {
    try {
      const saved = localStorage.getItem('migu_state');
      if (saved) {
        const d = JSON.parse(saved);
        state.favorites = d.favorites || [];
        state.playlists = d.playlists || {};
        state.volume = d.volume ?? 75;
        state.queue = d.queue || [];
        state.currentIndex = d.currentIndex ?? -1;
        state.repeat = d.repeat || 'off';
        state.shuffle = d.shuffle || false;
        state.listeningHistory = Array.isArray(d.listeningHistory) ? d.listeningHistory.slice(-120) : [];
        state.superSaverMode = !!d.superSaverMode;
        enforceStateLimits();
        if (state.currentIndex >= state.queue.length) {
          state.currentIndex = state.queue.length ? state.queue.length - 1 : -1;
        }
      }
    } catch (e) { /* silent */ }
  }

  function seedHistoryFromQueueIfNeeded() {
    if (state.listeningHistory.length >= 3) return;
    const source = (state.queue || []).slice(-15);
    if (!source.length) return;
    const existing = new Set(state.listeningHistory.map(h => h.videoId));
    const seeded = [];

    for (const s of source) {
      if (!s || !s.videoId || existing.has(s.videoId)) continue;
      seeded.push({
        videoId: s.videoId,
        title: s.title || '',
        author: s.author || '',
        listenRatio: 0.55,
        skippedEarly: false,
        liked: state.favorites.some(f => f.videoId === s.videoId),
        timestamp: Date.now() - 3600000
      });
      existing.add(s.videoId);
    }

    if (seeded.length) {
      state.listeningHistory = [...state.listeningHistory, ...seeded].slice(-150);
      saveState();
    }
  }

  function persistStateNow() {
    enforceStateLimits();
    try {
      localStorage.setItem('migu_state', JSON.stringify({
        favorites: state.favorites,
        playlists: state.playlists,
        volume: state.volume,
        queue: state.queue,
        currentIndex: state.currentIndex,
        repeat: state.repeat,
        shuffle: state.shuffle,
        listeningHistory: state.listeningHistory.slice(-120),
        superSaverMode: state.superSaverMode,
      }));
    } catch (e) { /* silent */ }
  }

  function saveState() {
    if (saveStateTimer) clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(() => {
      saveStateTimer = null;
      persistStateNow();
    }, SAVE_STATE_DEBOUNCE_MS);
  }

  function recordListeningSnapshot(song, ended = false) {
    if (!song || !song.videoId) return;
    const duration = Number(song.duration || audio.duration || 0);
    const listenedSec = Number(audio.currentTime || 0);
    const listenRatio = duration > 0 ? Math.max(0, Math.min(1, listenedSec / duration)) : 0;
    const skippedEarly = !ended && listenedSec > 0 && listenedSec < 25;
    const liked = state.favorites.some(f => f.videoId === song.videoId);

    state.listeningHistory.push({
      videoId: song.videoId,
      title: song.title || '',
      author: song.author || '',
      listenRatio: Number(listenRatio.toFixed(3)),
      skippedEarly,
      liked,
      timestamp: Date.now()
    });

    if (state.listeningHistory.length > 150) {
      state.listeningHistory = state.listeningHistory.slice(-150);
    }
    saveState();
    if (ended) void reportPlayComplete(song);
  }

  function initSupabaseClient() {
    if (supabase) return true;
    if (typeof window.supabase === 'undefined') return false;
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    return true;
  }

  // ── Room (Supabase Listen Together) ──────────────────────────────────
  function setupRoom() {
    if (!initSupabaseClient()) {
      console.warn('[MiGu] Supabase SDK not found. Room & community chart disabled.');
      return;
    }

    console.log('[MiGu] Supabase initialized');

    setupGlobalLobby();
    checkUrlForRoom();

    // Setup UI hooks
    $('#btn-create-room')?.addEventListener('click', () => {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code = '';
      for (let i = 0; i < 5; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));

      const name = $('#room-create-name')?.value.trim() || 'Phòng ' + code;
      const tags = $('#room-create-tags')?.value.trim() || '';

      window.currentRoomMetadata = { name, tags };
      hasShownSyncPrompt = true; // Creator doesn't need prompt

      joinRoomByCode(code, true);
    });

    $('#btn-join-room-code')?.addEventListener('click', () => {
      const code = $('#room-join-input').value.trim();
      if (code) joinRoomByCode(code);
    });

    $('#room-join-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#btn-join-room-code').click();
    });

    $('#btn-leave-room')?.addEventListener('click', async () => {
      if (roomChannel) {
        await supabase.removeChannel(roomChannel);
        roomChannel = null;
      }
      roomCode = null;
      isRoomHost = false;
      clearGuestAutoplayUnlock();
      pendingHostSyncSeek = null;
      hasShownSyncPrompt = false;
      if (globalLobbyChannel) globalLobbyChannel.untrack().catch(() => { });

      
      const tabRoom = $('#tab-room-queue');
      if (tabRoom) tabRoom.style.display = 'none';
      state.activeQueueTab = 'personal';
      $$('.queue-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'personal'));
      renderQueue();

      if (syncHeartbeat) { clearInterval(syncHeartbeat); syncHeartbeat = null; }
      resetGuestSyncPlaybackRate();
      $('#room-setup-panel').style.display = 'block';
      $('#room-active-panel').style.display = 'none';
      applyHostPermissions();
      updatePlayBtns(false);
      switchView('home');
      history.pushState({}, '', window.location.pathname);
      toast('Đã rời phòng', 'info');
    });

    $('#btn-copy-room-code')?.addEventListener('click', () => {
      if (!roomCode) return;
      navigator.clipboard.writeText(roomCode);
      toast('Đã copy mã phòng', 'success');
    });

    $('#btn-copy-room-link')?.addEventListener('click', () => {
      const link = window.location.origin + window.location.pathname + '?room=' + roomCode;
      navigator.clipboard.writeText(link);
      toast('Đã copy link phòng', 'success');
    });

    $('#host-sync-mode')?.addEventListener('change', (e) => {
      if (isRoomHost) {
        emitRoomState({ syncMode: e.target.checked ? 'sync' : 'start' });
        applyHostPermissions();
        toast(e.target.checked ? 'Đã bật ép đồng bộ' : 'Người nghe tự do', 'info');
      }
    });

    $('#room-chat-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#room-chat-input');
      const text = input.value.trim();
      if (text && roomChannel) {
        roomChannel.send({ type: 'broadcast', event: 'chat', payload: { text } });
        addChatMessage(text, true);
        input.value = '';
      }
    });

    $$('.btn-reaction').forEach(btn => {
      btn.addEventListener('click', () => {
        if (roomChannel) {
          const emoji = btn.dataset.emoji;
          roomChannel.send({ type: 'broadcast', event: 'reaction', payload: { emoji } });
          showReaction(emoji, true);
        }
      });
    });

    $('#btn-sync-yes')?.addEventListener('click', () => {
      if (window.resolveSyncPrompt) window.resolveSyncPrompt('sync');
    });
    $('#btn-sync-no')?.addEventListener('click', () => {
      if (window.resolveSyncPrompt) window.resolveSyncPrompt('start');
    });

    $('#btn-room-go-search')?.addEventListener('click', () => {
      switchView('search');
      const input = $('#search-input');
      if (input) input.focus();
    });

    $('#btn-room-go-paste')?.addEventListener('click', () => {
      switchView('paste');
      const input = $('#paste-input');
      if (input) input.focus();
    });
  }

  function setupQueueTabs() {
    $$('.queue-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        state.activeQueueTab = btn.dataset.tab;
        $$('.queue-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === state.activeQueueTab));
        renderQueue();
      });
    });
  }

  function isSyncActive() {
    const sm = $('#host-sync-mode');
    const mode = (sm && isRoomHost) ? (sm.checked ? 'sync' : 'start') : (window.userSyncChoice || 'sync');
    return roomCode && mode === 'sync';
  }

  /** In room nobody scrubs — host/guest. Tua gửi currentTime liên tục, gây lag; chỉ next/prev/play/volume. */
  function canScrubTimeline() {
    return !roomCode;
  }

  function setupGlobalLobby() {
    globalLobbyChannel = supabase.channel('global_lobby');
    globalLobbyChannel
      .on('presence', { event: 'sync' }, () => {
        const state = globalLobbyChannel.presenceState();
        activePublicRooms = [];
        for (const [key, presences] of Object.entries(state)) {
          if (presences[0] && presences[0].roomId) {
            activePublicRooms.push(presences[0]);
          }
        }
        renderLobbyRooms();
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          console.log('[Lobby] Connected to global lobby');
        }
      });

    $('#lobby-search-input')?.addEventListener('input', () => {
      renderLobbyRooms();
    });

    $('#nav-btn-room')?.addEventListener('click', () => {
    });
  }

  function renderLobbyRooms() {
    const container = $('#lobby-rooms-list');
    if (!container) return;

    const query = ($('#lobby-search-input')?.value || '').toLowerCase();

    const filtered = activePublicRooms.filter(r => {
      return (r.name && r.name.toLowerCase().includes(query)) ||
        (r.tags && r.tags.toLowerCase().includes(query)) ||
        (r.roomId && r.roomId.toLowerCase().includes(query));
    });

    if (filtered.length === 0) {
      container.innerHTML = `<div class="empty-state small" style="opacity: 0.5;">Chưa có phòng nào đang mở. Hãy tạo phòng của bạn nhé!</div>`;
      return;
    }

    container.innerHTML = filtered.map(r => `
      <div class="lobby-room-item" style="background: var(--surface); padding: 12px; border-radius: 8px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border); transition: all 0.2s;" onclick="joinRoomFromLobby('${r.roomId}')" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
        <div>
          <div style="font-weight: 600; font-size: 15px;">${esc(r.name)}</div>
          <div style="font-size: 12px; color: var(--accent); margin-top: 6px;"><i class="fas fa-tag"></i> ${esc(r.tags) || 'Không có tag'}</div>
        </div>
        <div style="font-size: 13px; opacity: 0.8; text-align: right;">
          <div style="margin-bottom: 4px;"><i class="fas fa-users"></i> ${r.usersCount || 1}</div>
          <div style="font-family: monospace; font-size: 12px; background: rgba(0,0,0,0.2); padding: 2px 6px; border-radius: 4px;">Mã: ${r.roomId}</div>
        </div>
      </div>
    `).join('');
  }

  window.joinRoomFromLobby = function (code) {
    if (code) joinRoomByCode(code);
  }

  function checkUrlForRoom() {
    if (window.location.search.includes('room=')) {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('room');
      if (code) {
        switchView('room');
        joinRoomByCode(code);
      }
    }
  }

  async function joinRoomByCode(code, isCreating = false, metadata = null) {
    if (metadata) window.currentRoomMetadata = metadata;
    clearGuestAutoplayUnlock();
    pendingHostSyncSeek = null;
    if (roomChannel) {
      await supabase.removeChannel(roomChannel);
    }



    // If creating a room, start fresh for the room queue
    if (isCreating) {
      state.roomQueue = [];
      state.currentIndex = -1;
      state.currentSongInfo = null;
      audio.src = '';
      updateUI(null);
      showBar(false);
      renderQueue();
      renderRoomQueue();
    }

    roomCode = code.toUpperCase();
    myRoomJoinedAt = Date.now();
    isProcessingRoomSync = true;
    window.targetSyncTime = null; // Clear any old sync time

    if (syncHeartbeat) clearInterval(syncHeartbeat);
    syncHeartbeat = setInterval(() => {
      if (isRoomHost && roomChannel && roomCode) emitRoomPlaybackTick();
    }, isSuperMode() ? ROOM_TICK_MS_SUPER : ROOM_TICK_MS);

    roomChannel = supabase.channel(`room:${roomCode}`, {
      config: { presence: { key: myUserId } }
    });

    roomChannel
      .on('presence', { event: 'sync' }, () => {
        const presence = roomChannel.presenceState();
        const users = Object.keys(presence);
        
        // Handle join/leave notifications via user count change
        const lastCount = parseInt($('#r-users-count')?.textContent || '0');
        if (users.length > lastCount && lastCount > 0) {
          toast('Một người vừa tham gia phòng 🎧', 'info');
        } else if (users.length < lastCount) {
          toast('Một người đã rời phòng', 'info');
        }

        const el = $('#r-users-count');
        if (el) el.textContent = users.length;


        // Host Election: stable earliest joined_at
        let hostId = null;
        let earliest = Number.POSITIVE_INFINITY;
        for (const [key, presences] of Object.entries(presence)) {
          const joinedAt = Number(presences?.[0]?.joined_at);
          if (!Number.isFinite(joinedAt)) continue;
          if (joinedAt < earliest) {
            earliest = joinedAt;
            hostId = key;
          }
        }
        if (!hostId) {
          const keys = Object.keys(presence).sort();
          hostId = keys[0] || null;
        }

        const wasHost = isRoomHost;
        isRoomHost = (hostId === myUserId);
        window.currentRoomHostId = hostId; // Store for broadcast validation
        const hc = $('#host-controls');
        if (hc) hc.style.display = isRoomHost ? 'block' : 'none';

        applyHostPermissions();

        if (isRoomHost) {
          if (!wasHost && !isCreating) {
            toast('Bạn đã trở thành Host', 'info');
            window.currentRoomMetadata = { name: 'Phòng ' + roomCode, tags: '' };
          }
          const meta = window.currentRoomMetadata || {};
          if (globalLobbyChannel) {
            globalLobbyChannel.track({
              roomId: roomCode,
              name: meta.name || 'Phòng ' + roomCode,
              tags: meta.tags || '',
              usersCount: users.length,
            }).catch(() => { });
          }
        } else {
          if (wasHost && globalLobbyChannel) {
            globalLobbyChannel.untrack().catch(() => { });
          }
        }
      })
      .on('presence', { event: 'join' }, ({ key, newPresences }) => {
        if (key !== myUserId) {
          // toast('Một người vừa tham gia', 'info'); // Handled by sync event now
          if (isRoomHost) emitRoomState({}, true);
        }
      })
      .on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
        if (key !== myUserId) console.log('[Room] User left');
      })
      .on('broadcast', { event: 'room_state' }, ({ payload }) => {
        handleStateUpdate(payload);
      })
      .on('broadcast', { event: 'chat' }, ({ payload }) => {
        addChatMessage(payload.text, false);
        toast(`Tin nhắn mới: ${payload.text}`, 'info');
      })
      .on('broadcast', { event: 'reaction' }, ({ payload }) => {
        showReaction(payload.emoji, false);
      })
      .on('broadcast', { event: 'sync_request' }, () => {
        if (isRoomHost) {
          console.log('[Sync] Received sync request, responding immediately...');
          emitRoomState({}, true);
        }
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          $('#room-setup-panel').style.display = 'none';
          $('#room-active-panel').style.display = 'flex';
          $('#r-code').textContent = roomCode;
          history.pushState({}, '', window.location.pathname + '?room=' + roomCode);
          toast('Đã tham gia phòng', 'success');
          isProcessingRoomSync = false;

          const tabRoom = $('#tab-room-queue');
          if (tabRoom) tabRoom.style.display = 'block';

          const metadata = window.currentRoomMetadata || {};
          await roomChannel.track({
            joined_at: myRoomJoinedAt
          });

          // Request initial sync from host
          setTimeout(() => {
            if (roomChannel) {
              console.log('[Sync] Requesting initial state from host...');
              roomChannel.send({ type: 'broadcast', event: 'sync_request', payload: {} });
            }
          }, 500);
        }
      });
  }

  function handleStateUpdate(update) {
    if (!roomCode || update.senderId === myUserId) return;

    // Strict Host Validation for playback updates
    const isPlaybackUpdate =
      update.currentSong !== undefined ||
      update.isPlaying !== undefined ||
      update.currentTime !== undefined ||
      update.syncAnchorAt !== undefined;
    if (isPlaybackUpdate && window.currentRoomHostId && update.senderId !== window.currentRoomHostId) {
      console.warn(`[Sync] Ignoring playback update from non-host: ${update.senderId}`);
      return;
    }

    isProcessingRoomSync = true;

    if (update.queue !== undefined) {
      const prevRoomQueueLen = state.roomQueue.length;
      const incoming = Array.isArray(update.queue) ? update.queue : [];

      if (isRoomHost && update.senderId !== myUserId) {
        const curVid = state.currentSongInfo?.videoId;
        const guestMissingNowPlaying =
          !!(curVid && !incoming.some((s) => s && s.videoId === curVid));

        if (guestMissingNowPlaying) {
          // Guest queue is behind (e.g. host skipped next). Do not replace — would drop the live track from the list.
          const hostIds = new Set(
            state.roomQueue.map((s) => s && s.videoId).filter(Boolean)
          );
          let appended = false;
          for (const s of incoming) {
            if (s && s.videoId && !hostIds.has(s.videoId)) {
              state.roomQueue.push(s);
              hostIds.add(s.videoId);
              appended = true;
            }
          }
          if (appended) {
            const ns = state.roomQueue[state.roomQueue.length - 1];
            if (ns) toast(`Bài mới được thêm: ${ns.title}`, 'success');
          }
          emitRoomState({}, true);
        } else {
          if (incoming.length > state.roomQueue.length && state.roomQueue.length > 0) {
            const newSong = incoming[incoming.length - 1];
            if (newSong) toast(`Bài mới được thêm: ${newSong.title}`, 'success');
          }
          state.roomQueue = incoming.slice();
        }
      } else if (!isRoomHost) {
        if (incoming.length > state.roomQueue.length && state.roomQueue.length > 0) {
          const newSong = incoming[incoming.length - 1];
          if (newSong) toast(`Bài mới được thêm: ${newSong.title}`, 'success');
        }
        state.roomQueue = incoming.slice();
      }

      if (state.activeQueueTab === 'room') renderQueue();
      renderRoomQueue();

      // Host: guest(s) added tracks while we were idle at the end of the current song — continue playlist
      if (isRoomHost && update.senderId !== myUserId && state.roomQueue.length > prevRoomQueueLen) {
        const dur = Number(audio.duration || 0);
        const cur = Number(audio.currentTime || 0);
        const atEnd = !state.isPlaying && state.currentSongInfo && (
          audio.ended ||
          (Number.isFinite(dur) && dur > 0 && cur >= dur - 0.85)
        );
        if (atEnd) {
          const vid = state.currentSongInfo.videoId;
          const idx = state.roomQueue.findIndex((s) => s && s.videoId === vid);
          if (idx >= 0 && idx < state.roomQueue.length - 1) {
            state.currentIndex = idx + 1;
            playSong(state.roomQueue[state.currentIndex], false);
          }
        }
      }
    }

    if (update.currentSong !== undefined && update.currentSong !== null) {
      const isNewSong = !state.currentSongInfo || state.currentSongInfo.videoId !== update.currentSong.videoId;

      if (isNewSong) {
        resetGuestSyncPlaybackRate();
        window.targetSyncTime = null;
        if (update.syncAnchorAt != null && update.syncAudioTime != null) {
          pendingHostSyncSeek = {
            syncAnchorAt: update.syncAnchorAt,
            syncAudioTime: update.syncAudioTime,
            isPlaying: update.isPlaying,
          };
        } else {
          pendingHostSyncSeek = null;
          window.targetSyncTime = update.currentTime ?? 0;
        }

        state.currentIndex = update.queue ? update.queue.findIndex(q => q.videoId === update.currentSong.videoId) : state.currentIndex;
        state.currentSongInfo = update.currentSong;
        updateUI(update.currentSong);
        showBar(true);

        try {
          audio.src = '/api/stream/' + update.currentSong.videoId;
          audio.load();

          audio.onloadedmetadata = () => {
            let seekSec = 0;
            if (pendingHostSyncSeek) {
              seekSec = getEffectiveHostPlaybackTime(pendingHostSyncSeek);
              pendingHostSyncSeek = null;
            } else if (window.targetSyncTime !== null) {
              seekSec = window.targetSyncTime;
              window.targetSyncTime = null;
            }
            console.log(`[Sync] Metadata loaded, jumping to: ${seekSec}s`);
            audio.currentTime = seekSec;
            if (update.isPlaying) {
              audio
                .play()
                .then(() => clearGuestAutoplayUnlock())
                .catch(() => scheduleGuestAutoplayUnlock());
            }
          };
        } catch (e) { /* ignore */ }
      } else if (window.targetSyncTime !== null) {
        resetGuestSyncPlaybackRate();
        const seekTo = window.targetSyncTime;
        window.targetSyncTime = null;
        console.log(`[Sync] Same song, immediate jump to: ${seekTo}s`);
        audio.currentTime = seekTo;
        if (update.isPlaying && audio.paused) {
          audio
            .play()
            .then(() => clearGuestAutoplayUnlock())
            .catch(() => scheduleGuestAutoplayUnlock());
        }
      }
    }

    if (update.syncMode !== undefined) {
      const sm = $('#host-sync-mode');
      if (sm) sm.checked = (update.syncMode === 'sync');
    }

    const isSync = (update.syncMode || ($('#host-sync-mode')?.checked ? 'sync' : 'start')) === 'sync';

    if (isSync) {
      if (update.isPlaying !== undefined) {
        if (update.isPlaying && audio.paused) {
          audio
            .play()
            .then(() => clearGuestAutoplayUnlock())
            .catch(() => scheduleGuestAutoplayUnlock());
        } else if (!update.isPlaying && !audio.paused) {
          audio.pause();
        }
        state.isPlaying = update.isPlaying;
        updatePlayBtns(update.isPlaying);
      }
      const canDriftCorrect =
        !isRoomHost &&
        window.targetSyncTime === null &&
        !pendingHostSyncSeek &&
        (update.syncAnchorAt != null || update.currentTime !== undefined);
      if (canDriftCorrect) {
        const hostT = getEffectiveHostPlaybackTime(update);
        if (audio.paused || !Number.isFinite(hostT)) {
          /* avoid fighting pause / invalid packets */
        } else {
          const localT = Number(audio.currentTime);
          if (!Number.isFinite(localT)) {
            /* still loading */
          } else {
            const delta = hostT - localT;
            const deviation = Math.abs(delta);
            const now = Date.now();
            const dur = Number(audio.duration || 0);

            // In sync: prefer gentle playbackRate nudges (no buffer flush) unless very far behind/ahead.
            if (deviation <= 0.55) {
              if (Math.abs(audio.playbackRate - 1) > 0.004) {
                scheduleGuestPlaybackRateReset(700);
              }
            } else if (deviation < 6) {
              const sign = delta > 0 ? 1 : -1;
              const bump = Math.min(0.06, deviation * 0.009);
              try {
                audio.playbackRate = Math.max(0.93, Math.min(1.07, 1 + sign * bump));
                scheduleGuestPlaybackRateReset(5200);
              } catch (_) { /* ignore */ }
            } else if (now - lastDriftCorrectionAt > 5200) {
              lastDriftCorrectionAt = now;
              resetGuestSyncPlaybackRate();
              console.log(`[Sync] Hard correct drift: ${deviation.toFixed(2)}s`);
              const cap = Number.isFinite(dur) && dur > 0 ? Math.max(0, dur - 0.08) : hostT;
              audio.currentTime = Math.max(0, Math.min(hostT + 0.06, cap));
            }
          }
        }
      }
    } else {
      // async mode: if new song, play from 0
      if (update.currentSong && (!state.currentSongInfo || state.currentSongInfo.videoId !== update.currentSong.videoId)) {
        audio.currentTime = 0;
        audio.play().catch(() => { });
      }
    }

    isProcessingRoomSync = false;
  }

  /** Chỉ mốc phát + trạng thái — không gửi lại queue (giảm tải Supabase realtime). */
  function emitRoomPlaybackTick() {
    if (!roomChannel || !roomCode || !isRoomHost) return;
    const now = Date.now();
    roomChannel.send({
      type: 'broadcast',
      event: 'room_state',
      payload: {
        senderId: myUserId,
        syncAnchorAt: now,
        syncAudioTime: audio.currentTime,
        isPlaying: state.isPlaying,
        syncMode: $('#host-sync-mode')?.checked ? 'sync' : 'start',
        currentSong: state.currentSongInfo,
      },
    });
  }

  function emitRoomState(partialState = {}, force = false) {
    if (!roomChannel || !roomCode || (isProcessingRoomSync && !force)) return;

    const now = Date.now();
    if (
      isRoomHost &&
      !force &&
      Object.keys(partialState).length === 0 &&
      now - lastHostEmitAt < HOST_EMIT_DEBOUNCE_MS
    ) {
      return;
    }

    const update = {
      senderId: myUserId,
      queue: state.roomQueue,
      ...partialState,
    };

    if (isRoomHost) {
      const anchorNow = Date.now();
      update.currentSong = state.currentSongInfo;
      update.isPlaying = state.isPlaying;
      update.syncAnchorAt = anchorNow;
      update.syncAudioTime = audio.currentTime;
      update.currentTime = audio.currentTime;
      update.syncMode = $('#host-sync-mode')?.checked ? 'sync' : 'start';
      lastHostEmitAt = Date.now();
      roomChannel.send({ type: 'broadcast', event: 'room_state', payload: update });
    } else if (partialState.queue) {
      roomChannel.send({
        type: 'broadcast',
        event: 'room_state',
        payload: { senderId: myUserId, queue: partialState.queue || state.roomQueue },
      });
    }
  }

  function addChatMessage(text, isSelf) {
    const box = $('#room-chat-messages');
    if (!box) return;
    const el = document.createElement('div');
    el.style.padding = '8px 12px';
    el.style.borderRadius = '16px';
    el.style.maxWidth = '85%';
    el.style.fontSize = '14px';
    el.style.lineHeight = '1.4';
    if (isSelf) {
      el.style.alignSelf = 'flex-end';
      el.style.background = 'var(--accent)';
      el.style.color = 'white';
      el.style.borderBottomRightRadius = '4px';
    } else {
      el.style.alignSelf = 'flex-start';
      el.style.background = 'rgba(255,255,255,0.1)';
      el.style.color = 'white';
      el.style.borderBottomLeftRadius = '4px';
    }
    el.textContent = text;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
  }

  function showReaction(emoji, isSelf) {
    const el = document.createElement('div');
    el.textContent = emoji;
    el.style.position = 'fixed';
    el.style.fontSize = '40px';
    el.style.zIndex = '9999';
    el.style.pointerEvents = 'none';
    el.style.transition = 'all 2.5s cubic-bezier(0.2, 0.8, 0.2, 1)';
    el.style.left = isSelf ? '80%' : (10 + Math.random() * 60) + '%';
    el.style.bottom = '100px';
    el.style.opacity = '1';
    el.style.transform = 'translateY(0) scale(0.5)';
    document.body.appendChild(el);

    requestAnimationFrame(() => {
      el.style.transform = `translateY(-${300 + Math.random() * 200}px) scale(1.5) rotate(${Math.random() * 40 - 20}deg)`;
      el.style.opacity = '0';
    });

    setTimeout(() => el.remove(), 2500);
  }

  function renderRoomQueue() {
    const container = $('#room-queue-container');
    if (!container) return;
    const entries = isSuperMode()
      ? getWindowedEntries(state.roomQueue, state.currentIndex, SUPER_ROOM_QUEUE_RENDER_LIMIT)
      : state.roomQueue.map((item, index) => ({ item, index }));
    container.innerHTML = entries.map(({ item: song, index: i }) => `
      <div class="queue-item ${state.currentSongInfo && song.videoId === state.currentSongInfo.videoId ? 'active' : ''}" style="margin-bottom:8px;" data-index="${i}">
        <span class="queue-item-index" style="color:var(--text-secondary);font-size:12px;width:20px;text-align:center;">${i + 1}</span>
        <img class="queue-item-thumb" src="${song.thumbnail}" alt="" loading="lazy" style="width:40px;height:40px;border-radius:4px;object-fit:cover;">
        <div class="queue-item-info">
          <div class="queue-item-title">${esc(song.title)}</div>
          <div class="queue-item-artist">${esc(song.author)}</div>
        </div>
        <div class="queue-item-actions" style="margin-left:auto; display:flex; gap:5px;">
           <button class="btn-icon q-room-up" data-index="${i}" title="Chuyển lên đợi phát">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
           </button>
           <button class="btn-icon q-room-remove" data-index="${i}" title="Xóa">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
           </button>
        </div>
      </div>
    `).join('');

    container.onclick = (e) => {
      const upBtn = e.target.closest('.q-room-up');
      if (upBtn) {
        e.stopPropagation();
        const idx = parseInt(upBtn.dataset.index, 10);
        if (idx > 0 && idx !== state.currentIndex) {
          let target = state.currentIndex >= 0 ? state.currentIndex + 1 : 0;
          if (target > idx) target--; // Compensate for the element we are about to remove

          const song = state.roomQueue.splice(idx, 1)[0];
          state.roomQueue.splice(target, 0, song);

          if (idx < state.currentIndex && target >= state.currentIndex) state.currentIndex--;
          else if (idx > state.currentIndex && target <= state.currentIndex) state.currentIndex++;

          renderRoomQueue();
          if (state.activeQueueTab === 'room') renderQueue();
          saveState();
          emitRoomState({ queue: state.roomQueue });
        }
        return;
      }

      const removeBtn = e.target.closest('.q-room-remove');
      if (removeBtn) {
        e.stopPropagation();
        const idx = parseInt(removeBtn.dataset.index, 10);
        state.roomQueue.splice(idx, 1);
        if (idx < state.currentIndex) state.currentIndex--;
        else if (idx === state.currentIndex) {
          if (state.roomQueue.length === 0) {
            state.currentIndex = -1; audio.pause(); audio.src = '';
            state.isPlaying = false; updatePlayBtns(false); showBar(false);
          } else {
            state.currentIndex = Math.min(state.currentIndex, state.roomQueue.length - 1);
            if (isRoomHost) playSong(state.roomQueue[state.currentIndex], false);
          }
        }
        renderRoomQueue();
        if (state.activeQueueTab === 'room') renderQueue();
        saveState();
        emitRoomState({ queue: state.roomQueue });
      }
    };
  }


  // ── Particles ─────────────────────────────────────────────────
  function setupParticles() {
    const c = $('#particles');
    if (!c) return;
    c.innerHTML = '';
    if (isSuperMode()) {
      c.style.display = 'none';
      return;
    }
    c.style.display = '';
    const particleCount = state.lowPerformanceMode ? 8 : 25;
    for (let i = 0; i < particleCount; i++) {
      const p = document.createElement('div');
      p.className = 'particle';
      p.style.left = Math.random() * 100 + '%';
      p.style.animationDuration = (15 + Math.random() * 25) + 's';
      p.style.animationDelay = Math.random() * 20 + 's';
      p.style.width = p.style.height = (1 + Math.random() * 2) + 'px';
      c.appendChild(p);
    }
  }

  // ── Navigation ────────────────────────────────────────────────
  function setupNavigation() {
    $$('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    $$('.quick-action-card').forEach(card => {
      card.addEventListener('click', () => switchView(card.dataset.view));
    });

    const goNp = $('#pb-goto-np');
    if (goNp) goNp.addEventListener('click', () => {
      if (state.currentIndex >= 0) switchView('nowplaying');
    });

    const expand = $('#pb-expand');
    if (expand) expand.addEventListener('click', () => switchView('nowplaying'));

    const npHome = $('#np-btn-home');
    if (npHome) npHome.addEventListener('click', () => switchView('home'));

    // Favorites button in sidebar
    $('#btn-favorites')?.addEventListener('click', () => switchView('favorites'));
  }

  function switchView(view) {
    state.currentView = view;
    $$('.view').forEach(v => v.classList.remove('active'));
    const el = $(`#view-${view}`);
    if (el) el.classList.add('active');

    $$('.nav-btn').forEach(b => b.classList.remove('active'));
    const navBtn = $(`.nav-btn[data-view="${view}"]`);
    if (navBtn) navBtn.classList.add('active');

    const bar = $('#player-bar');
    if (view === 'nowplaying') bar.style.display = 'none';
    else if (state.currentIndex >= 0) bar.style.display = '';

    if (view === 'search') setTimeout(() => $('#search-input')?.focus(), 100);
    if (view === 'favorites') renderFavoritesList();
    if (view === 'home') {
      loadTrending({ preferCache: true });
      loadCommunityChart({ preferCache: true });
      if (!isSuperMode()) loadPersonalizedRecommendations({ preferCache: true });
    }

    resetIdle();
  }

  // ── Search ────────────────────────────────────────────────────
  function setupSearch() {
    const input = $('#search-input');
    const clear = $('#search-clear');
    const sugBox = $('#suggestions-container');

    input.addEventListener('input', () => {
      if (isSuperMode()) {
        clear.style.display = input.value.trim() ? '' : 'none';
        sugBox.style.display = 'none';
        return;
      }
      const q = input.value.trim();
      clear.style.display = q ? '' : 'none';
      clearTimeout(state.searchDebounce);
      if (!q) { sugBox.style.display = 'none'; return; }

      state.searchDebounce = setTimeout(async () => {
        try {
          const res = await fetch(`/api/suggest?q=${encodeURIComponent(q)}`);
          const items = await res.json();
          if (items.length > 0) {
            sugBox.innerHTML = items.slice(0, 6).map(s =>
              `<div class="suggestion-item" data-q="${esc(s)}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                ${esc(s)}
              </div>`
            ).join('');
            sugBox.style.display = '';
            sugBox.querySelectorAll('.suggestion-item').forEach(el => {
              el.addEventListener('click', () => {
                input.value = el.dataset.q;
                sugBox.style.display = 'none';
                performSearch(el.dataset.q);
              });
            });
          } else sugBox.style.display = 'none';
        } catch (e) { /* silent */ }
      }, 300);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        sugBox.style.display = 'none';
        performSearch(input.value.trim());
      }
    });

    clear.addEventListener('click', () => {
      input.value = '';
      clear.style.display = 'none';
      sugBox.style.display = 'none';
      $('#search-results').innerHTML = `<div class="empty-state">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <p>Nhập tên bài hát để tìm kiếm</p></div>`;
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-container')) sugBox.style.display = 'none';
    });
  }

  async function performSearch(q) {
    if (!q) return;
    const results = $('#search-results');
    results.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!data.results || data.results.length === 0) {
        results.innerHTML = '<div class="empty-state"><p>Không tìm thấy kết quả</p></div>';
        return;
      }
      results.innerHTML = data.results.map(item => renderResultItem(item)).join('');
      bindResultActions(results);
    } catch (err) {
      results.innerHTML = `<div class="empty-state">
        <p>Lỗi tìm kiếm. Thử lại sau.</p>
        <button class="btn-primary" id="btn-rotate-client" style="margin-top:12px;font-size:12px;">
          🔄 Đổi server tìm kiếm
        </button>
      </div>`;
      $('#btn-rotate-client')?.addEventListener('click', async () => {
        try {
          const r = await fetch('/api/rotate-client', { method: 'POST' });
          const d = await r.json();
          toast(`Đã đổi sang server: ${d.client}`, 'success');
          performSearch(q);
        } catch (e) {
          toast('Không thể đổi server', 'error');
        }
      });
    }
  }

  function renderResultItem(item) {
    const isFav = state.favorites.some(f => f.videoId === item.videoId);
    return `
      <div class="result-item" data-id="${item.videoId}">
        <img class="result-thumb" src="${item.thumbnail}" alt="" loading="lazy">
        <div class="result-info">
          <div class="result-title">${esc(item.title)}</div>
          <div class="result-meta"><span>${esc(item.author)}</span><span>${fmtDur(item.duration)}</span></div>
        </div>
        <div class="result-actions">
          <button class="result-action-btn play-btn" title="Phát" data-action="play">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </button>
          <button class="result-action-btn add-btn" title="Thêm vào hàng chờ" data-action="add">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
          <button class="result-action-btn fav-btn ${isFav ? 'is-fav' : ''}" title="Yêu thích" data-action="fav">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
          </button>
        </div>
      </div>`;
  }

  function bindResultActions(container) {
    container.querySelectorAll('.result-item').forEach(item => {
      const id = item.dataset.id;
      const song = {
        videoId: id,
        title: item.querySelector('.result-title').textContent,
        author: item.querySelector('.result-meta span').textContent,
        thumbnail: item.querySelector('.result-thumb').src,
        duration: parseDur(item.querySelectorAll('.result-meta span')[1]?.textContent || '0:00')
      };

      item.querySelector('[data-action="play"]')?.addEventListener('click', (e) => { e.stopPropagation(); playSong(song); });
      item.querySelector('[data-action="add"]')?.addEventListener('click', (e) => { e.stopPropagation(); addToQueue(song); toast('Đã thêm vào hàng chờ', 'success'); });
      item.querySelector('[data-action="fav"]')?.addEventListener('click', (e) => {
        e.stopPropagation(); toggleFav(song);
        e.currentTarget.classList.toggle('is-fav', state.favorites.some(f => f.videoId === id));
      });
      item.addEventListener('click', () => playSong(song));
    });
  }

  // ── Paste Link ────────────────────────────────────────────────
  function setupPasteLink() {
    const input = $('#paste-input');
    const btn = $('#btn-paste-play');

    btn.addEventListener('click', () => handlePaste(input.value.trim()));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') handlePaste(input.value.trim()); });
    input.addEventListener('paste', () => setTimeout(() => handlePaste(input.value.trim()), 100));
  }

  function extractId(url) {
    if (url.includes('soundcloud.com/') || url.includes('spotify.com/') || url.includes('tiktok.com/')) {
      return { videoId: encodeURIComponent(url) };
    }

    // Check for playlist first
    const listPattern = /[&?]list=([a-zA-Z0-9_-]+)/;
    const listMatch = url.match(listPattern);
    const playlistId = listMatch ? listMatch[1] : null;

    const videoPatterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/
    ];
    let videoId = null;
    for (const p of videoPatterns) { const m = url.match(p); if (m) { videoId = m[1]; break; } }

    if (!videoId && !playlistId) return null;
    return { videoId, playlistId };
  }

  async function handlePaste(url) {
    if (!url) return;
    const ids = extractId(url);
    if (!ids) { toast('Link không hợp lệ', 'error'); return; }

    const { videoId, playlistId } = ids;

    // If it's a playlist, we prioritize that flow
    if (playlistId) {
      handlePlaylistPaste(playlistId, videoId);
      return;
    }

    const preview = $('#paste-preview');
    preview.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

    try {
      const res = await fetch(`/api/info/${videoId}`);
      const info = await res.json();
      if (info.error) { preview.innerHTML = `<div class="empty-state small"><p>${info.error}</p></div>`; return; }

      const song = { videoId: info.videoId, title: info.title, author: info.author, thumbnail: info.thumbnail, duration: info.duration };

      preview.innerHTML = `
        <div class="result-item" style="background:var(--glass);border-radius:var(--r-md);padding:12px;">
          <img class="result-thumb" src="${info.thumbnail}" alt="" style="width:80px;height:60px">
          <div class="result-info">
            <div class="result-title">${esc(info.title)}</div>
            <div class="result-meta"><span>${esc(info.author)}</span><span>${fmtDur(info.duration)}</span></div>
          </div>
        </div>`;

      playSong(song);
      toast('Đang phát: ' + info.title, 'success');
    } catch (err) {
      preview.innerHTML = '<div class="empty-state small"><p>Không thể tải thông tin</p></div>';
      toast('Lỗi tải video', 'error');
    }
  }

  async function handlePlaylistPaste(playlistId, startVideoId) {
    const preview = $('#paste-preview');
    preview.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p style="margin-top:10px;font-size:12px;color:var(--text-secondary)">Đang tải playlist...</p></div>';

    try {
      // 1. Fetch playlist items (first 15)
      // Pass startVideoId as 'v' param for Mix context
      const res = await fetch(`/api/playlist-info/${playlistId}${startVideoId ? '?v=' + startVideoId : ''}`);
      const data = await res.json();
      if (data.error || !data.items || data.items.length === 0) {
        throw new Error(data.error || 'Playlist trống hoặc không hợp lệ');
      }

      // 2. Determine playlist name
      const count = Object.keys(state.playlists).length + 1;
      const playlistName = `Playlist ${count}`;

      // 3. Add to state
      state.playlists[playlistName] = data.items;
      saveState();
      renderPlaylists();

      // 4. Play the first song (from the playlist or startVideoId)
      let firstSong = data.items[0];
      if (startVideoId) {
        const found = data.items.find(i => i.videoId === startVideoId);
        if (found) firstSong = found;
      }

      preview.innerHTML = `
        <div class="empty-state small" style="background:var(--accent-soft);border:1px solid var(--accent);border-radius:var(--r-md);padding:14px;text-align:center">
          <svg style="width:24px;height:24px;color:var(--accent);margin-bottom:8px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
          <div style="font-weight:600;margin-bottom:4px">Đã nhập Playlist!</div>
          <div style="font-size:12px;opacity:0.8">Tạo thành công "${playlistName}" với ${data.items.length} bài hát.</div>
        </div>`;

      playSong(firstSong);
      toast(`Đã tạo ${playlistName} và bắt đầu phát`, 'success');

    } catch (err) {
      console.error('[MiGu] Playlist error:', err);
      preview.innerHTML = `<div class="empty-state small"><p>Lỗi: ${err.message}</p></div>`;
      toast('Lỗi tải playlist', 'error');
    }
  }

  // ── Player Core ───────────────────────────────────────────────
  async function playSong(song, addQ = true) {
    // If in room and synced, and we are NOT the host, we should not be calling playSong directly unless it's a specific local override
    if (roomCode && isSyncActive() && !isRoomHost) {
      console.log('[Room] Guest requested track while synced, directing to room queue.');
      addToQueue(song);
      return;
    }

    const previousSong = state.currentSongInfo;
    if (previousSong && previousSong.videoId !== song.videoId) {
      recordListeningSnapshot(previousSong, false);
    }

    if (addQ) {
      const q = (roomCode && isRoomHost) ? state.roomQueue : state.queue;
      const idx = q.findIndex(q => q.videoId === song.videoId);
      if (idx >= 0) state.currentIndex = idx;
      else { q.push(song); state.currentIndex = q.length - 1; }
    }

    if (roomCode && isRoomHost) {
      const rq = state.roomQueue;
      if (!rq.some((s) => s && s.videoId === song.videoId)) {
        const ins =
          Number.isFinite(state.currentIndex) && state.currentIndex >= 0
            ? Math.min(state.currentIndex, rq.length)
            : rq.length;
        rq.splice(ins, 0, song);
        state.currentIndex = rq.findIndex((s) => s && s.videoId === song.videoId);
      }
    }

    state.currentSongInfo = song;
    nextStreamPrefetchVideoId = null;
    endStallNudgeCount = 0;
    updateUI(song);
    showBar(true);
    switchView('nowplaying');

    try {
      audio.src = `/api/stream/${encodeURIComponent(song.videoId)}`;
      audio.load();
      await audio.play();
      state.isPlaying = true;
      updatePlayBtns(true);
      $('#np-disc')?.classList.add('spinning');
      tryPrefetchNextTrackUrl();
      loadRecommendations(song.videoId);
      loadPersonalizedRecommendations({ preferCache: true });
      if (isRoomHost) emitRoomState();
    } catch (err) {
      console.error('Play error:', err);
      toast('Không thể phát bài hát này', 'error');
    }

    saveState();
    renderQueue();
    renderRoomQueue();
    updateDiscordRPC();
  }

  function updateDiscordRPC() {
    if (window.electronAPI && state.currentSongInfo) {
      window.electronAPI.updateRPC({
        title: state.currentSongInfo.title,
        author: state.currentSongInfo.author,
        duration: state.currentSongInfo.duration,
        currentTime: audio.currentTime,
        isPlaying: state.isPlaying
      });
    }
  }

  function updateUI(song) {
    if (!song) {
      if ($('#np-title')) $('#np-title').textContent = '---';
      if ($('#np-artist')) $('#np-artist').textContent = '---';
      const art = $('#np-artwork'); if (art) art.src = '';
      if ($('#pb-title')) $('#pb-title').textContent = '---';
      if ($('#pb-artist')) $('#pb-artist').textContent = '---';
      const pbT = $('#pb-thumb'); if (pbT) pbT.src = '';
      if ($('#room-np-title')) $('#room-np-title').textContent = 'Đang không phát';
      if ($('#room-np-artist')) $('#room-np-artist').textContent = '---';
      const rnT = $('#room-np-thumb'); if (rnT) rnT.src = '';
      updateFavBtns(false);
      if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
      return;
    }

    if ($('#np-title')) $('#np-title').textContent = song.title || '---';
    if ($('#np-artist')) $('#np-artist').textContent = song.author || '---';
    const art = $('#np-artwork');
    if (art) { art.src = song.thumbnail || ''; art.onerror = () => { art.src = ''; }; }

    if ($('#pb-title')) $('#pb-title').textContent = song.title || '---';
    if ($('#pb-artist')) $('#pb-artist').textContent = song.author || '---';
    const pbT = $('#pb-thumb');
    if (pbT) { pbT.src = song.thumbnail || ''; pbT.onerror = () => { pbT.src = ''; }; }

    if ($('#room-np-title')) $('#room-np-title').textContent = song.title || '---';
    if ($('#room-np-artist')) $('#room-np-artist').textContent = song.author || '---';
    const rnT = $('#room-np-thumb');
    if (rnT) { rnT.src = song.thumbnail || ''; rnT.onerror = () => { rnT.src = ''; }; }

    const isFav = state.favorites.some(f => f.videoId === song.videoId);
    updateFavBtns(isFav);

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title, artist: song.author,
        artwork: song.thumbnail ? [{ src: song.thumbnail, sizes: '512x512', type: 'image/jpeg' }] : []
      });
    }

    // Update dynamic backdrop
    if (song.thumbnail) updateDynamicBackdrop(song.thumbnail);
  }

  function updateDynamicBackdrop(url) {
    if (state.lowPerformanceMode || isSuperMode()) return;
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.src = url;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = 10;
      canvas.height = 10;
      ctx.drawImage(img, 0, 0, 10, 10);
      const data = ctx.getImageData(0, 0, 10, 10).data;

      let r = 0, g = 0, b = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i]; g += data[i + 1]; b += data[i + 2];
      }
      r = Math.floor(r / (data.length / 4));
      g = Math.floor(g / (data.length / 4));
      b = Math.floor(b / (data.length / 4));

      // Increase saturation/brightness for accent
      const accent = `rgba(${r}, ${g}, ${b}, 0.45)`;
      const bg = `rgba(${Math.max(0, r - 40)}, ${Math.max(0, g - 40)}, ${Math.max(0, b - 40)}, 0.35)`;

      console.log('[MiGu] Dynamic colors:', accent, bg);
      document.documentElement.style.setProperty('--dynamic-accent', accent);
      document.documentElement.style.setProperty('--dynamic-bg', bg);
    };
    img.onerror = (e) => console.error('[MiGu] Color extraction failed (CORS?):', url, e);
  }

  function showBar(show) {
    const bar = $('#player-bar');
    if (show && state.currentView !== 'nowplaying') bar.style.display = '';
    else if (!show) bar.style.display = 'none';
  }

  function updatePlayBtns(playing) {
    const npBtn = $('#np-btn-play');
    const pbBtn = $('#pb-play');
    const rmBtn = $('#room-btn-play');

    if (npBtn) npBtn.innerHTML = playing ? SVG.pause : SVG.play;
    if (pbBtn) pbBtn.innerHTML = playing ? SVG.pause : SVG.play;
    if (rmBtn) rmBtn.innerHTML = playing ? SVG.pause : SVG.play;

    const disc = $('#np-disc');
    const roomDisc = $('#room-np-thumb');

    if (playing) {
      disc?.classList.add('spinning');
      roomDisc?.classList.add('spinning');
    } else {
      disc?.classList.remove('spinning');
      roomDisc?.classList.remove('spinning');
    }
  }

  function updateFavBtns(isFav) {
    const npFav = $('#np-toggle-fav');
    const pbFav = $('#pb-fav');
    if (npFav) { npFav.classList.toggle('is-fav', isFav); if (isFav) npFav.querySelector('svg')?.setAttribute('fill', 'var(--accent)'); else npFav.querySelector('svg')?.setAttribute('fill', 'none'); }
    if (pbFav) { pbFav.classList.toggle('is-fav', isFav); if (isFav) pbFav.querySelector('svg')?.setAttribute('fill', 'var(--accent)'); else pbFav.querySelector('svg')?.setAttribute('fill', 'none'); }
  }

  // ── Visualizer (2D only) ─────────────────────────────────────
  let audioCtx = null;
  let analyser = null;
  let source = null;

  function setupVisualizer() {
    const canvas = $('#np-visualizer');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    const initCtx = () => {
      if (audioCtx) return;
      console.log('[MiGu] Initializing Web Audio Context...');
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      source = audioCtx.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
      analyser.fftSize = 128;

      drawVisualizer();
      window.removeEventListener('click', initCtx);
      window.removeEventListener('keydown', initCtx);
    };

    window.addEventListener('click', initCtx);
    window.addEventListener('keydown', initCtx);

    function drawVisualizer() {
      if (!analyser) return;
      requestAnimationFrame(drawVisualizer);
      if (isSuperMode()) return;

      if (state.lowPerformanceMode) {
        const now = Date.now();
        if (now - state.lastVisualizerFrameAt < 66) return; // ~15 FPS
        state.lastVisualizerFrameAt = now;
      }

      if (state.currentView !== 'nowplaying') return;
      if (state.lowPerformanceMode && !state.isPlaying) return;

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      analyser.getByteFrequencyData(dataArray);

      const w = canvas.width = 260;
      const h = canvas.height = 260;
      ctx.clearRect(0, 0, w, h);

      const centerX = w / 2;
      const centerY = h / 2;
      const radius = 100;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * 40;
        const angle = (i / bufferLength) * Math.PI * 2;
        const x1 = centerX + Math.cos(angle) * radius;
        const y1 = centerY + Math.sin(angle) * radius;
        const x2 = centerX + Math.cos(angle) * (radius + barHeight);
        const y2 = centerY + Math.sin(angle) * (radius + barHeight);

        ctx.strokeStyle = `rgba(255, 255, 255, ${0.3 + (dataArray[i] / 255) * 0.7})`;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }
  }

  // ── Player Controls ───────────────────────────────────────────
  let playbackWatchdogTimer = null;
  let watchdogStallMs = 0;
  let watchdogPrevTime = 0;
  let endTransitionLock = false;
  let stallRecoverAttempts = 0;
  let pendingResumeTime = null;

  function setupPlayerControls() {
    const handleTrackEnded = (fromWatchdog = false) => {
      if (endTransitionLock) return;
      endTransitionLock = true;

      if (state.currentSongInfo) recordListeningSnapshot(state.currentSongInfo, true);
      state.isPlaying = false;
      updatePlayBtns(false);
      emitRoomState({ isPlaying: false });

      if (state.repeat === 'one') {
        audio.currentTime = 0;
        audio.play().then(() => {
          state.isPlaying = true;
          updatePlayBtns(true);
        }).catch(() => { });
      } else {
        if (fromWatchdog) console.warn('[MiGu] Watchdog forced track end transition.');
        nextTrack();
      }

      setTimeout(() => { endTransitionLock = false; }, 400);
    };

    const toggle = () => {
      if (!audio.src) return;
      if (state.isPlaying) {
        audio.pause();
        state.isPlaying = false;
        updatePlayBtns(false);
        emitRoomState({ isPlaying: false });
        updateDiscordRPC();
      } else {
        // updatePlayBtns must be called AFTER play() resolves
        audio.play().then(() => {
          state.isPlaying = true;
          updatePlayBtns(true);
          emitRoomState({ isPlaying: true });
          updateDiscordRPC();
        }).catch((err) => {
          console.warn('Play rejected:', err);
        });
      }
    };

    $('#np-btn-play')?.addEventListener('click', toggle);
    $('#pb-play')?.addEventListener('click', toggle);
    $('#room-btn-play')?.addEventListener('click', toggle);

    $('#np-btn-next')?.addEventListener('click', () => nextTrack());
    $('#np-btn-prev')?.addEventListener('click', () => prevTrack());
    $('#pb-next')?.addEventListener('click', () => nextTrack());
    $('#pb-prev')?.addEventListener('click', () => prevTrack());
    $('#room-btn-next')?.addEventListener('click', () => nextTrack());
    $('#room-btn-prev')?.addEventListener('click', () => prevTrack());

    // Shuffle
    const shuffleBtn = $('#np-btn-shuffle');
    shuffleBtn?.addEventListener('click', () => {
      state.shuffle = !state.shuffle;
      shuffleBtn.classList.toggle('active', state.shuffle);
      saveState();
      toast(state.shuffle ? 'Phát ngẫu nhiên: Bật' : 'Phát ngẫu nhiên: Tắt', 'info');
    });
    shuffleBtn?.classList.toggle('active', state.shuffle);

    // Repeat
    const repeatBtn = $('#np-btn-repeat');
    repeatBtn?.addEventListener('click', () => {
      const modes = ['off', 'all', 'one'];
      state.repeat = modes[(modes.indexOf(state.repeat) + 1) % 3];
      repeatBtn.classList.toggle('active', state.repeat !== 'off');
      saveState();
      const labels = { off: 'Lặp lại: Tắt', all: 'Lặp lại tất cả', one: 'Lặp lại 1 bài' };
      toast(labels[state.repeat], 'info');
    });
    repeatBtn?.classList.toggle('active', state.repeat !== 'off');

    // Progress seeking (NP) — disabled in room for everyone (no scrub spam on realtime)
    $('#np-progress-bar')?.addEventListener('click', (e) => {
      if (!canScrubTimeline()) return;
      const rect = e.currentTarget.getBoundingClientRect();
      if (audio.duration) {
        audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
        emitRoomState({ currentTime: audio.currentTime });
      }
    });

    // Progress seeking (PB)
    $('#pb-progress')?.addEventListener('click', (e) => {
      if (!canScrubTimeline()) return;
      const rect = e.currentTarget.getBoundingClientRect();
      if (audio.duration) {
        audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
        emitRoomState({ currentTime: audio.currentTime });
      }
    });

    // Audio events
    audio.addEventListener('timeupdate', () => {
      if (!audio.duration) return;
      watchdogPrevTime = audio.currentTime;
      watchdogStallMs = 0;
      stallRecoverAttempts = 0;
      const pct = (audio.currentTime / audio.duration) * 100;
      const npFill = $('#np-progress-fill');
      const pbFill = $('#pb-progress-fill');
      if (npFill) npFill.style.width = pct + '%';
      if (pbFill) pbFill.style.width = pct + '%';
      $('#np-current-time').textContent = fmtDur(audio.currentTime);
      $('#np-duration').textContent = fmtDur(audio.duration);
      $('#pb-time').textContent = `${fmtDur(audio.currentTime)} / ${fmtDur(audio.duration)}`;

      const remSec = Number(audio.duration - audio.currentTime);
      if (remSec <= 55 && remSec > 5) tryPrefetchNextTrackUrl();
    });

    audio.addEventListener('ended', () => {
      handleTrackEnded(false);
    });

    audio.addEventListener('error', (e) => {
      console.error('Audio error:', e);
      if (!audio.src || audio.src === window.location.href || !state.currentSongInfo) return;
      toast('Lỗi phát nhạc. Đang thử lại...', 'error');
      setTimeout(() => {
        if (state.currentSongInfo) {
          audio.src = `/api/stream/${state.currentSongInfo.videoId}?t=${Date.now()}`;
          audio.load();
          audio.play().then(() => { state.isPlaying = true; updatePlayBtns(true); }).catch(() => { });
        }
      }, 2000);
    });

    audio.addEventListener('loadedmetadata', () => {
      if (pendingResumeTime !== null && Number.isFinite(pendingResumeTime)) {
        try {
          audio.currentTime = Math.max(0, Math.min(pendingResumeTime, (audio.duration || pendingResumeTime)));
        } catch (_) { }
        pendingResumeTime = null;
      }
    });

    audio.addEventListener('waiting', () => {
      if (!state.isPlaying || !audio.duration) return;
      const rem = audio.duration - audio.currentTime;
      if (rem < 50 && rem > 2) tryPrefetchNextTrackUrl();
    });

    // Failsafe: some streams stall near end and never emit "ended"
    if (playbackWatchdogTimer) clearInterval(playbackWatchdogTimer);
    playbackWatchdogTimer = setInterval(() => {
      if (!state.isPlaying || !audio.src) return;
      const dur = Number(audio.duration || 0);
      if (!Number.isFinite(dur) || dur <= 0) return;

      const cur = Number(audio.currentTime || 0);
      const remaining = dur - cur;
      const progressed = Math.abs(cur - watchdogPrevTime) > 0.02;

      if (progressed) {
        watchdogStallMs = 0;
        watchdogPrevTime = cur;
        return;
      }

      watchdogStallMs += 1000;

      // Mid-song stall recovery: refresh stream and resume from stuck timestamp
      if (remaining > 2.2 && watchdogStallMs >= 8000) {
        if (stallRecoverAttempts < 2 && state.currentSongInfo?.videoId) {
          stallRecoverAttempts++;
          const resumeAt = Math.max(0, cur - 0.3);
          pendingResumeTime = resumeAt;
          const vid = encodeURIComponent(state.currentSongInfo.videoId);
          audio.src = `/api/stream/${vid}?recover=${Date.now()}&r=${stallRecoverAttempts}`;
          audio.load();
          audio.play().then(() => {
            state.isPlaying = true;
            updatePlayBtns(true);
          }).catch(() => { });
          watchdogStallMs = 0;
          return;
        }

        // Recovery exhausted -> skip to avoid permanent freeze
        handleTrackEnded(true);
        return;
      }

      // Near end: nhẹ nhàng nudge timeline — decoder/buffer đôi khi bị kẹt vài giây
      if (
        remaining <= 14 &&
        remaining > 0.06 &&
        watchdogStallMs >= 800 &&
        endStallNudgeCount < 6
      ) {
        endStallNudgeCount++;
        try {
          audio.currentTime = Math.min(cur + 0.12, dur - 0.03);
        } catch (_) { /* ignore */ }
        watchdogStallMs = 0;
        watchdogPrevTime = Number(audio.currentTime || 0);
        return;
      }

      // Chỉ ép chuyển bài khi đứng thật lâu (buffer cuối có thể mất >3s)
      if (remaining <= 10 && watchdogStallMs >= 9000) {
        handleTrackEnded(true);
      }
    }, 1000);

    // Favorite buttons
    $('#np-toggle-fav')?.addEventListener('click', () => {
      if (!state.currentSongInfo) return;
      toggleFav(state.currentSongInfo);
      updateFavBtns(state.favorites.some(f => f.videoId === state.currentSongInfo.videoId));
    });
    $('#np-btn-fav')?.addEventListener('click', () => {
      if (!state.currentSongInfo) return;
      toggleFav(state.currentSongInfo);
      updateFavBtns(state.favorites.some(f => f.videoId === state.currentSongInfo.videoId));
    });
    $('#pb-fav')?.addEventListener('click', () => {
      if (!state.currentSongInfo) return;
      toggleFav(state.currentSongInfo);
      updateFavBtns(state.favorites.some(f => f.videoId === state.currentSongInfo.videoId));
    });

    // Queue clear
    $('#btn-clear-queue')?.addEventListener('click', () => {
      const isRoomTab = roomCode && state.activeQueueTab === 'room';
      if (isRoomTab) {
        const cur = state.roomQueue[state.currentIndex];
        state.roomQueue = cur ? [cur] : [];
        state.currentIndex = cur ? 0 : -1;
        renderRoomQueue();
        renderQueue();
        saveState();
        toast('Đã xóa hàng chờ phòng', 'info');
        emitRoomState({ queue: state.roomQueue });
      } else {
        const cur = state.queue[state.currentIndex];
        state.queue = cur ? [cur] : [];
        state.currentIndex = cur ? 0 : -1;
        renderQueue();
        if (roomCode) renderRoomQueue();
        saveState();
        toast('Đã xóa hàng chờ', 'info');
      }
    });
  }

  async function nextTrack() {
    const q = getActivePlaybackQueue();
    if (q.length === 0) return;
    if (state.shuffle) {
      let n; do { n = Math.floor(Math.random() * q.length); } while (n === state.currentIndex && q.length > 1);
      state.currentIndex = n;
    } else {
      state.currentIndex++;
      if (state.currentIndex >= q.length) {
        if (state.repeat === 'all') state.currentIndex = 0;
        else {
          state.currentIndex = q.length - 1;
          const shouldAutoplayFromMixed =
            canAutoplayFromSuggestions() &&
            !(roomCode && isRoomHost);
          const suggestSong = shouldAutoplayFromMixed
            ? await getAutoplayMixedSuggestionSong()
            : null;
          if (suggestSong) {
            const targetQ = roomCode && isRoomHost ? state.roomQueue : state.queue;
            if (!targetQ.some((s) => s && s.videoId === suggestSong.videoId)) {
              targetQ.push(suggestSong);
            }
            state.currentIndex = targetQ.length - 1;
            playSong(suggestSong, false);
            return;
          }
          state.isPlaying = false;
          updatePlayBtns(false);
          return;
        }
      }
    }
    const song = q[state.currentIndex];
    if (song) playSong(song, false);
  }

  function prevTrack() {
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    const q = getActivePlaybackQueue();
    if (q.length === 0) return;
    state.currentIndex = Math.max(0, state.currentIndex - 1);
    const song = q[state.currentIndex];
    if (song) playSong(song, false);
  }

  // ── Volume ────────────────────────────────────────────────────
  function setupVolumeControls() {
    const npS = $('#np-volume-slider');
    const pbS = $('#pb-volume');
    npS.value = state.volume;
    pbS.value = state.volume;

    const setVol = (v) => {
      state.volume = parseInt(v);
      audio.volume = state.volume / 100;
      npS.value = v; pbS.value = v;
      saveState();
    };

    npS.addEventListener('input', (e) => setVol(e.target.value));
    pbS.addEventListener('input', (e) => setVol(e.target.value));

    const toggleMute = () => {
      if (audio.volume > 0) { state._pv = state.volume; setVol(0); }
      else setVol(state._pv || 75);
    };
    $('#np-btn-volume')?.addEventListener('click', toggleMute);
    $('#pb-volume-btn')?.addEventListener('click', toggleMute);
  }

  // ── Queue ─────────────────────────────────────────────────────
  function addToQueue(song) {
    const targetQ = roomCode ? state.roomQueue : state.queue;
    if (!targetQ.some(q => q.videoId === song.videoId)) {
      targetQ.push(song);
      if (targetQ.length > MAX_QUEUE_ITEMS) {
        targetQ.splice(0, targetQ.length - MAX_QUEUE_ITEMS);
        state.currentIndex = Math.max(-1, state.currentIndex - 1);
      }
      renderQueue();
      if (roomCode) renderRoomQueue();
      saveState();
      if (roomCode) emitRoomState({ queue: state.roomQueue });
      toast('Đã thêm vào hàng chờ', 'success');
    } else {
      toast('Đã có trong hàng chờ', 'info');
    }
  }

  function renderQueue() {
    const list = $('#queue-container');
    if (!list) return;

    const isRoom = roomCode && state.activeQueueTab === 'room';
    const q = isRoom ? state.roomQueue : state.queue;

    const clearBtn = $('#btn-clear-queue');
    if (clearBtn) {
      clearBtn.style.display = q.length > 0 ? 'block' : 'none';
      clearBtn.textContent = isRoom ? 'Xóa Room Q' : 'Xóa sạch';
    }

    if (q.length === 0) {
      list.innerHTML = `<div class="empty-state small"><p>${isRoom ? 'Hàng chờ phòng trống' : 'Chưa có bài hát nào'}</p></div>`;
      return;
    }

    const entries = isSuperMode()
      ? getWindowedEntries(q, state.currentIndex, SUPER_QUEUE_RENDER_LIMIT)
      : q.map((item, index) => ({ item, index }));

    list.innerHTML = entries.map(({ item: song, index: i }) => `
      <div class="queue-item ${state.currentSongInfo && song.videoId === state.currentSongInfo.videoId ? 'active' : ''}" data-index="${i}">
        <span class="queue-item-index">${(state.currentSongInfo && song.videoId === state.currentSongInfo.videoId) ? '▶' : (i + 1)}</span>
        <img class="queue-item-thumb" src="${song.thumbnail}" alt="" loading="lazy">
        <div class="queue-item-info">
          <div class="queue-item-title">${esc(song.title)}</div>
          <div class="queue-item-artist">${esc(song.author)}</div>
        </div>
        <button class="queue-item-remove" data-index="${i}" title="Xóa">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    `).join('');

    list.onclick = async (e) => {
      const removeBtn = e.target.closest('.queue-item-remove');
      if (removeBtn) {
        e.stopPropagation();
        const idx = parseInt(removeBtn.dataset.index, 10);
        if (isRoom) {
          state.roomQueue.splice(idx, 1);
          emitRoomState({ queue: state.roomQueue });
          renderRoomQueue();
        } else {
          state.queue.splice(idx, 1);
          if (idx < state.currentIndex) state.currentIndex--;
          else if (idx === state.currentIndex) {
            // handle current removal if needed
          }
        }
        renderQueue();
        saveState();
        return;
      }

      const item = e.target.closest('.queue-item');
      if (!item) return;
      const idx = parseInt(item.dataset.index, 10);

      if (isRoom) {
        if (isRoomHost) playSong(state.roomQueue[idx], false);
        else toast('Chỉ Host mới có quyền chọn bài phát trực tiếp', 'info');
      } else {
        if (roomCode && isSyncActive()) {
          const agreed = await showConfirmModal({
            title: 'Rời chế độ nghe chung?',
            message: 'Bạn sẽ chuyển sang phát danh sách cá nhân.',
            confirmText: 'Tiếp tục',
            cancelText: 'Ở lại phòng'
          });
          if (agreed) {
            window.userSyncChoice = 'start'; // "start" mode = unsynced local
            playSong(state.queue[idx], false);
          }
        } else {
          state.currentIndex = idx;
          playSong(state.queue[idx], false);
        }
      }
    };

    const active = list.querySelector('.queue-item.active');
    if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ── Favorites ─────────────────────────────────────────────────
  function toggleFav(song) {
    const idx = state.favorites.findIndex(f => f.videoId === song.videoId);
    if (idx >= 0) { state.favorites.splice(idx, 1); toast('Đã xóa khỏi yêu thích', 'info'); }
    else { state.favorites.unshift(song); toast('Đã thêm vào yêu thích ❤️', 'success'); }
    state.listeningHistory.forEach(h => {
      if (h.videoId === song.videoId) h.liked = state.favorites.some(f => f.videoId === song.videoId);
    });
    saveState();
    $('#fav-count').textContent = state.favorites.length;
    // Refresh view if currently open
    if (state.currentView === 'favorites') renderFavoritesList();
  }

  function renderFavoritesList() {
    const list = $('#favorites-list');
    const sub = $('#fav-sub');
    const n = state.favorites.length;
    if (sub) sub.textContent = `${n} bài hát`;
    if (!list) return;

    if (n === 0) {
      list.innerHTML = `<div class="empty-state">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
        <p>Chưa có bài hát yêu thích nào</p></div>`;
      return;
    }

    const rows = isSuperMode()
      ? state.favorites.slice(0, SUPER_FAVORITES_RENDER_LIMIT)
      : state.favorites;
    list.innerHTML = rows.map(item => renderResultItem(item)).join('');
    bindResultActions(list);
  }

  function openPlaylistView(name) {
    state.currentPlaylistView = name;
    const songs = state.playlists[name] || [];
    const titleEl = $('#playlist-view-title');
    const subEl = $('#playlist-view-sub');
    const listEl = $('#playlist-songs-list');
    const playAllBtn = $('#btn-playlist-play-all');

    if (titleEl) titleEl.textContent = '🎵 ' + name;
    if (subEl) subEl.textContent = `${songs.length} bài hát`;

    if (!listEl) return;

    if (songs.length === 0) {
      listEl.innerHTML = '<div class="empty-state"><p>Playlist trống — thêm bài hát từ kết quả tìm kiếm</p></div>';
    } else {
      listEl.innerHTML = songs.map((item, idx) => `
        <div class="result-item playlist-row" draggable="true" data-index="${idx}">
          <div style="cursor:grab; opacity:.6; width:20px; text-align:center;" title="Kéo để đổi vị trí">☰</div>
          <img class="result-thumb" src="${item.thumbnail}" alt="" loading="lazy">
          <div class="result-info">
            <div class="result-title">${esc(item.title)}</div>
            <div class="result-meta"><span>${esc(item.author || '')}</span><span>${fmtDur(item.duration || 0)}</span></div>
          </div>
          <div class="result-actions">
            <button class="result-action-btn play-btn" title="Phát" data-action="play">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </button>
            <button class="result-action-btn add-btn" title="Thêm vào hàng chờ" data-action="add">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button class="result-action-btn" title="Xóa khỏi playlist" data-action="remove">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
      `).join('');
      bindPlaylistActions(name);
    }

    // Play all button
    playAllBtn?.removeEventListener('click', playAllBtn._handler);
    playAllBtn._handler = () => {
      if (songs.length === 0) return;
      state.queue = [...songs];
      state.currentIndex = 0;
      playSong(state.queue[0], false);
    };
    playAllBtn?.addEventListener('click', playAllBtn._handler);

    const del = $('#btn-delete-playlist');
    if (del) {
      del.style.display = 'inline-flex';
      del.onclick = async () => {
        const playlistName = state.currentPlaylistView;
        if (!playlistName || !state.playlists[playlistName]) return;
        const agreed = await showConfirmModal({
          title: 'Xóa playlist',
          message: `Playlist "${playlistName}" sẽ bị xóa vĩnh viễn.`,
          confirmText: 'Xóa playlist',
          cancelText: 'Hủy',
          danger: true
        });
        if (!agreed) return;
        delete state.playlists[playlistName];
        saveState();
        renderPlaylists();
        switchView('home');
        toast('Đã xóa playlist', 'info');
      };
    }

    switchView('playlist');
  }

  function bindPlaylistActions(playlistName) {
    const listEl = $('#playlist-songs-list');
    const songs = state.playlists[playlistName] || [];
    if (!listEl) return;

    listEl.querySelectorAll('.playlist-row').forEach(row => {
      const idx = parseInt(row.dataset.index, 10);
      const song = songs[idx];
      if (!song) return;

      row.querySelector('[data-action="play"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        playSong(song);
      });
      row.querySelector('[data-action="add"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        addToQueue(song);
        toast('Đã thêm vào hàng chờ', 'success');
      });
      row.querySelector('[data-action="remove"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        state.playlists[playlistName].splice(idx, 1);
        saveState();
        renderPlaylists();
        openPlaylistView(playlistName);
        toast('Đã xóa bài khỏi playlist', 'info');
      });
    });

    let dragIndex = -1;
    listEl.querySelectorAll('.playlist-row').forEach(row => {
      row.addEventListener('dragstart', () => {
        dragIndex = parseInt(row.dataset.index, 10);
        row.style.opacity = '0.5';
      });
      row.addEventListener('dragend', () => {
        row.style.opacity = '1';
      });
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const dropIndex = parseInt(row.dataset.index, 10);
        if (Number.isNaN(dragIndex) || Number.isNaN(dropIndex) || dragIndex === dropIndex) return;
        const arr = state.playlists[playlistName];
        const moved = arr.splice(dragIndex, 1)[0];
        arr.splice(dropIndex, 0, moved);
        saveState();
        renderPlaylists();
        openPlaylistView(playlistName);
        toast('Đã sắp xếp lại playlist', 'success');
      });
    });
  }

  function canAutoplayFromSuggestions() {
    if (isSuperMode()) return false;
    if (roomCode && isSyncActive() && !isRoomHost) return false;
    return true;
  }

  /** Bài gợi ý đầu tiên (khác bài hiện tại) để nối khi hết queue */
  function getAutoplaySuggestionSong() {
    const curId = state.currentSongInfo?.videoId;
    const list = state.lastRecommendationVideos || [];
    for (const v of list) {
      if (!v?.videoId || v.videoId === curId) continue;
      return {
        videoId: v.videoId,
        title: v.title || '',
        author: v.author || '',
        thumbnail: v.thumbnail || '',
        duration: Number(v.duration) || 0,
      };
    }
    return null;
  }

  /** Luon lay bai dau tien tu tab "Da dang" de autoplay khi het queue ca nhan. */
  async function getAutoplayMixedSuggestionSong() {
    const curId = state.currentSongInfo?.videoId;
    if (!curId) return null;

    if (state.activeSuggestTab === 'mixed') {
      const cached = getAutoplaySuggestionSong();
      if (cached) return cached;
    }

    try {
      const res = await fetch(`/api/info/${encodeURIComponent(curId)}?suggest=mixed`);
      const data = await res.json();
      const recs = Array.isArray(data?.recommendedVideos) ? data.recommendedVideos : [];
      for (const v of recs) {
        if (!v?.videoId || v.videoId === curId) continue;
        return {
          videoId: v.videoId,
          title: v.title || '',
          author: v.author || '',
          thumbnail: v.thumbnail || '',
          duration: Number(v.duration) || 0,
        };
      }
    } catch (_) {
      // Ignore and let player stop normally when suggestions are unavailable.
    }

    return null;
  }

  function fmtSuggestViews(n) {
    const x = Number(n);
    if (!x || x < 1) return '';
    if (x >= 1e6) return `${(x / 1e6).toFixed(1).replace(/\.0$/, '')} Tr xem`;
    if (x >= 1e3) return `${Math.round(x / 1e3)} N xem`;
    return `${x} xem`;
  }

  function syncSuggestTabUi() {
    const wrap = $('#suggest-tabs');
    if (!wrap) return;
    wrap.querySelectorAll('.suggest-tab').forEach((b) => {
      const on = (b.dataset.suggestTab || 'mixed') === state.activeSuggestTab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function setupSuggestTabs() {
    const wrap = $('#suggest-tabs');
    if (!wrap) return;
    wrap.querySelectorAll('.suggest-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.suggestTab || 'mixed';
        const vid = state.currentSongInfo?.videoId;
        if (!vid) return;
        if (state.activeSuggestTab === t) return;
        loadRecommendations(vid, t);
      });
    });
  }

  /** Kéo thanh giữa hàng chờ / gợi ý để chỉnh tỷ lệ (lưu localStorage). */
  function setupNpPanelSplitter() {
    const right = document.querySelector('.np-right');
    const split = document.getElementById('np-panel-splitter');
    if (!right || !split) return;

    const FR_TOTAL = 2;
    const clampFr = (x) => Math.max(0.55, Math.min(1.55, x));

    let npQueueFr = 1;
    try {
      const raw = localStorage.getItem('np_queue_fr');
      if (raw != null) {
        const n = parseFloat(raw, 10);
        if (!Number.isNaN(n)) npQueueFr = clampFr(n);
      }
    } catch (e) {
      /* ignore */
    }

    function applyNpGrid() {
      const q = clampFr(npQueueFr);
      npQueueFr = q;
      const s = FR_TOTAL - q;
      right.style.gridTemplateRows = `minmax(72px, ${q}fr) 5px minmax(96px, ${s}fr)`;
    }
    applyNpGrid();

    let dragging = false;
    let startY = 0;
    let startFr = 1;

    function onStart(clientY) {
      dragging = true;
      startY = clientY;
      startFr = npQueueFr;
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    }
    function onMove(clientY) {
      if (!dragging) return;
      const h = right.getBoundingClientRect().height || 1;
      const dy = clientY - startY;
      npQueueFr = clampFr(startFr + (dy / h) * 1.35);
      applyNpGrid();
    }
    function onEnd() {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        localStorage.setItem('np_queue_fr', String(npQueueFr));
      } catch (e) {
        /* ignore */
      }
    }

    split.setAttribute('tabindex', '0');
    split.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      onStart(e.clientY);
    });
    document.addEventListener('mousemove', (e) => onMove(e.clientY));
    document.addEventListener('mouseup', onEnd);

    split.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length !== 1) return;
        e.preventDefault();
        onStart(e.touches[0].clientY);
      },
      { passive: false }
    );
    document.addEventListener(
      'touchmove',
      (e) => {
        if (!dragging || !e.touches[0]) return;
        e.preventDefault();
        onMove(e.touches[0].clientY);
      },
      { passive: false }
    );
    document.addEventListener('touchend', onEnd);

    split.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 0.04 : -0.04;
        npQueueFr = clampFr(npQueueFr + step);
        applyNpGrid();
        try {
          localStorage.setItem('np_queue_fr', String(npQueueFr));
        } catch (err) {
          /* ignore */
        }
      }
    });
  }

  // ── Recommendations ───────────────────────────────────────────
  async function loadRecommendations(videoId, suggestTab) {
    const container = $('#suggest-container');
    const tabsWrap = $('#suggest-tabs');
    const hintEl = $('#suggest-type-hint');
    if (!container) return;
    if (isSuperMode()) {
      state.lastRecommendationVideos = [];
      if (tabsWrap) tabsWrap.style.display = 'none';
      if (hintEl) { hintEl.hidden = true; hintEl.textContent = ''; }
      container.innerHTML = '<div class="empty-state small"><p>Super mode: tắt gợi ý để tiết kiệm hiệu năng</p></div>';
      return;
    }
    if (tabsWrap) tabsWrap.style.display = '';
    if (suggestTab === undefined || suggestTab === null) {
      state.activeSuggestTab = 'mixed';
    } else {
      state.activeSuggestTab = suggestTab;
    }
    syncSuggestTabUi();
    container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

    try {
      const tab = encodeURIComponent(state.activeSuggestTab || 'mixed');
      const res = await fetch(`/api/info/${encodeURIComponent(videoId)}?suggest=${tab}`);
      const data = await res.json();
      const recs = data.recommendedVideos || [];
      state.lastRecommendationVideos = recs;

      if (hintEl) {
        const meta = data.suggestMeta;
        if (state.activeSuggestTab === 'related' || !meta?.typeLabel) {
          hintEl.hidden = true;
          hintEl.textContent = '';
        } else {
          hintEl.textContent = `Nhận diện thể loại: ${meta.typeLabel}`;
          hintEl.hidden = false;
        }
      }

      if (recs.length === 0) {
        container.innerHTML = '<div class="empty-state small"><p>Không có gợi ý</p></div>';
        return;
      }

      container.innerHTML = recs.map((v) => {
        const extra = [v.published || '', fmtSuggestViews(v.viewCount)].filter(Boolean).join(' · ');
        return `
        <div class="suggest-item" data-id="${v.videoId}">
          <img class="suggest-thumb" src="${v.thumbnail}" alt="" loading="lazy">
          <div class="suggest-info">
            <div class="suggest-title">${esc(v.title)}</div>
            <div class="suggest-artist">${esc(v.author)}</div>
            ${extra ? `<div class="suggest-extra">${esc(extra)}</div>` : ''}
          </div>
          <div class="suggest-actions">
            <button class="suggest-action-btn play" title="Phát" data-action="play">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </button>
            <button class="suggest-action-btn add" title="Thêm vào hàng chờ" data-action="add">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
          </div>
        </div>`;
      }).join('');

      container.querySelectorAll('.suggest-item').forEach((item) => {
        const song = {
          videoId: item.dataset.id,
          title: item.querySelector('.suggest-title').textContent,
          author: item.querySelector('.suggest-artist').textContent,
          thumbnail: item.querySelector('.suggest-thumb').src,
          duration: 0,
        };
        item.querySelector('[data-action="play"]')?.addEventListener('click', (e) => { e.stopPropagation(); playSong(song); });
        item.querySelector('[data-action="add"]')?.addEventListener('click', (e) => { e.stopPropagation(); addToQueue(song); toast('Đã thêm vào hàng chờ', 'success'); });
        item.addEventListener('click', () => playSong(song));
      });
    } catch (err) {
      state.lastRecommendationVideos = [];
      if (hintEl) { hintEl.hidden = true; hintEl.textContent = ''; }
      container.innerHTML = '<div class="empty-state small"><p>Không tải được gợi ý</p></div>';
    }
  }

  // ── Trending ──────────────────────────────────────────────────
  function setupTrendingTabs() {
    const wrap = $('#trending-tabs');
    if (!wrap) return;
    wrap.querySelectorAll('.trending-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cat = btn.dataset.category || 'all';
        if (state.trendingCategory === cat) return;
        state.trendingCategory = cat;
        wrap.querySelectorAll('.trending-tab').forEach((b) => {
          const on = b === btn;
          b.classList.toggle('active', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        loadTrending({ preferCache: true });
      });
    });
  }

  function renderTrendingRows(rows) {
    const container = $('#trending-container');
    if (!container) return;
    if (!rows || rows.length === 0) {
      container.innerHTML = '<div class="empty-state small"><p>Không tải được nhạc thịnh hành</p></div>';
      return;
    }
    const visibleRows = isSuperMode() ? rows.slice(0, SUPER_TRENDING_RENDER_LIMIT) : rows;
    container.innerHTML = visibleRows.map(song => renderSongCard(song)).join('');
    bindSongCards(container);
  }

  async function loadTrending(options = {}) {
    const { preferCache = false, force = false } = options;
    const container = $('#trending-container');
    if (!container) return;
    const cat = state.trendingCategory || 'all';
    const cacheRow = homeTrendingCache.get(cat);

    if (!force && preferCache && isFreshHomeCache(cacheRow)) {
      renderTrendingRows(cacheRow.rows || []);
      return;
    }

    if (!force && homeTrendingInFlight.has(cat)) {
      if (!preferCache) {
        container.innerHTML = '<div class="loading-spinner" style="grid-column: 1 / -1; padding: 80px 0;"><div class="spinner"></div></div>';
      }
      await homeTrendingInFlight.get(cat);
      return;
    }

    if (!preferCache || !cacheRow) {
      container.innerHTML = '<div class="loading-spinner" style="grid-column: 1 / -1; padding: 80px 0;"><div class="spinner"></div></div>';
    } else {
      renderTrendingRows(cacheRow.rows || []);
    }

    const request = (async () => {
      try {
        const url = cat === 'all' ? '/api/trending' : `/api/trending?category=${encodeURIComponent(cat)}`;
        const res = await fetch(url);
        const data = await res.json();

        const rows = Array.isArray(data.results) ? data.results : [];
        if (rows.length === 0) {
          if (!cacheRow) container.innerHTML = '<div class="empty-state small"><p>Không tải được nhạc thịnh hành</p></div>';
          return;
        }

        homeTrendingCache.set(cat, { rows, t: Date.now() });
        renderTrendingRows(rows);
      } catch (err) {
        if (!cacheRow) container.innerHTML = '<div class="empty-state small"><p>Không tải được nhạc thịnh hành</p></div>';
      } finally {
        homeTrendingInFlight.delete(cat);
      }
    })();
    homeTrendingInFlight.set(cat, request);

    try {
      await request;
    } catch (_) { /* handled in request */ }
  }

  function setupCommunityChartPlayAll() {
    const btn = $('#btn-play-community-chart');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const list = state.communityChartSongs || [];
      if (list.length === 0) return;
      state.queue = list.map((t) => ({
        videoId: t.videoId,
        title: t.title,
        author: t.author,
        thumbnail: t.thumbnail,
        duration: t.duration || 0,
      }));
      state.currentIndex = 0;
      playSong(state.queue[0], false);
      toast('Đang phát Top nghe nhiều', 'success');
    });
  }

  async function reportPlayComplete(song) {
    if (!song || !song.videoId) return;
    if (!initSupabaseClient()) return;
    try {
      const { error } = await supabase.rpc('increment_song_play', {
        p_video_id: String(song.videoId).slice(0, 32),
        p_title: String(song.title || '').slice(0, 500),
        p_author: String(song.author || '').slice(0, 300),
      });
      if (error) console.warn('[MiGu] increment_song_play:', error.message);
      else if (state.currentView === 'home') loadCommunityChart({ preferCache: true });
    } catch (e) {
      console.warn('[MiGu] reportPlayComplete', e);
    }
  }

  function rankBadgeClass(rank) {
    if (rank === 1) return 'song-card-rank song-card-rank--gold';
    if (rank === 2) return 'song-card-rank song-card-rank--silver';
    if (rank === 3) return 'song-card-rank song-card-rank--bronze';
    return 'song-card-rank';
  }

  function renderChartSongCard(song) {
    const rk = rankBadgeClass(song.rank);
    return `
      <div class="song-card song-card--chart" data-id="${song.videoId}">
        <span class="${rk}">${song.rank}</span>
        <img class="song-card-thumb" src="${esc(song.thumbnail)}" alt="" loading="lazy">
        <div class="song-card-overlay">
          <div class="song-card-play">
            <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
          </div>
        </div>
        <div class="song-card-info">
          <div class="song-card-title">${esc(song.title)}</div>
          <div class="song-card-artist">${esc(song.author)}</div>
          <div class="song-card-chart-meta">${song.plays} lần nghe</div>
        </div>
      </div>`;
  }

  function renderCommunityChartRows(rows) {
    const container = $('#community-chart-container');
    const btn = $('#btn-play-community-chart');
    if (!container) return;
    const list = Array.isArray(rows) ? rows : [];

    state.communityChartSongs = list.map((r) => ({
      videoId: r.videoId,
      title: r.title,
      author: r.author,
      thumbnail: r.thumbnail,
      duration: 0,
    }));

    if (list.length === 0) {
      container.innerHTML = `<div class="empty-state small" style="grid-column: 1 / -1;">
        <p>Chưa có dữ liệu — phát <strong>hết</strong> một bài để +1 lên bảng</p>
      </div>`;
      if (btn) btn.style.display = 'none';
      return;
    }

    if (btn) btn.style.display = '';
    container.innerHTML = list.map((s) => renderChartSongCard(s)).join('');
    bindCommunityChartCards(container);
  }

  async function loadCommunityChart(options = {}) {
    const { preferCache = false, force = false } = options;
    const container = $('#community-chart-container');
    const btn = $('#btn-play-community-chart');
    if (!container) return;

    if (isSuperMode() && !force) {
      container.innerHTML = '<div class="empty-state small" style="grid-column: 1 / -1;"><p>Super mode: ẩn Top nghe nhiều để tiết kiệm hiệu năng</p></div>';
      if (btn) btn.style.display = 'none';
      state.communityChartSongs = [];
      return;
    }

    if (!force && preferCache && isFreshHomeCache(homeCommunityCache)) {
      renderCommunityChartRows(homeCommunityCache.rows || []);
      return;
    }

    if (!force && homeCommunityInFlight) {
      if (!preferCache) {
        container.innerHTML = '<div class="loading-spinner" style="grid-column: 1 / -1; padding: 30px 0;"><div class="spinner"></div></div>';
      }
      await homeCommunityInFlight;
      return;
    }

    if (!initSupabaseClient()) {
      container.innerHTML = `<div class="empty-state small" style="grid-column: 1 / -1;">
        <p>Chưa tải được Supabase (thiếu SDK hoặc mạng)</p>
      </div>`;
      if (btn) btn.style.display = 'none';
      state.communityChartSongs = [];
      return;
    }

    const limit = isSuperMode() ? 8 : 10;
    if (!preferCache || !homeCommunityCache) {
      container.innerHTML = '<div class="loading-spinner" style="grid-column: 1 / -1; padding: 30px 0;"><div class="spinner"></div></div>';
    } else {
      renderCommunityChartRows(homeCommunityCache.rows || []);
    }

    homeCommunityInFlight = (async () => {
      try {
        const { data, error } = await supabase
          .from('song_play_stats')
          .select('video_id,title,author,play_count')
          .order('play_count', { ascending: false })
          .limit(limit);

        if (error) {
          console.warn('[MiGu] loadCommunityChart:', error.message);
          if (!homeCommunityCache) {
            container.innerHTML = `<div class="empty-state small" style="grid-column: 1 / -1;">
              <p>Không tải được BXH — kiểm tra bảng <code>song_play_stats</code> và policy (xem <code>supabase/migrations</code>).</p>
            </div>`;
            if (btn) btn.style.display = 'none';
            state.communityChartSongs = [];
          }
          return;
        }

        const rows = (data || []).map((row, i) => ({
          videoId: row.video_id,
          title: row.title || 'Không có tiêu đề',
          author: row.author || '',
          thumbnail: `https://i.ytimg.com/vi/${row.video_id}/mqdefault.jpg`,
          duration: 0,
          plays: Number(row.play_count) || 0,
          rank: i + 1,
        }));

        homeCommunityCache = { rows, t: Date.now() };
        renderCommunityChartRows(rows);
      } finally {
        homeCommunityInFlight = null;
      }
    })();

    await homeCommunityInFlight;
  }

  function renderPersonalizedRows(rows) {
    const container = $('#recommended-container');
    if (!container) return;
    const results = Array.isArray(rows) ? rows : [];
    if (results.length === 0) {
      container.innerHTML = `<div class="empty-state small" style="grid-column: 1 / -1;">
        <p>Chưa đủ dữ liệu để đề xuất</p>
      </div>`;
      return;
    }

    container.innerHTML = results.map(song => `
      <div class="song-card" data-id="${song.videoId}" data-reason="${esc(song.reason || '')}">
        <img class="song-card-thumb" src="${song.thumbnail}" alt="" loading="lazy">
        <div class="song-card-overlay">
          <div class="song-card-play">
            <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
          </div>
        </div>
        <span class="song-card-duration">${fmtDur(song.duration)}</span>
        <div class="song-card-info">
          <div class="song-card-title">${esc(song.title)}</div>
          <div class="song-card-artist">${esc(song.author)}</div>
          <div class="song-card-artist" style="color: var(--accent); font-size: 11px;">${esc(song.reason || 'Đề xuất cho bạn')}</div>
        </div>
      </div>
    `).join('');
    bindSongCards(container);
  }

  async function loadPersonalizedRecommendations(options = {}) {
    const { preferCache = false, force = false } = options;
    const container = $('#recommended-container');
    if (!container) return;
    if (isSuperMode()) {
      container.innerHTML = '<div class="empty-state small" style="grid-column: 1 / -1;"><p>Super mode: tắt gợi ý cá nhân</p></div>';
      return;
    }
    seedHistoryFromQueueIfNeeded();
    const historySig = getHistorySignature();

    if (!state.listeningHistory || state.listeningHistory.length < 3) {
      container.innerHTML = `<div class="empty-state small" style="grid-column: 1 / -1;">
        <p>Phát thêm vài bài để cá nhân hóa gợi ý</p>
      </div>`;
      return;
    }

    const canUseCache =
      !force &&
      preferCache &&
      isFreshHomeCache(homePersonalizedCache) &&
      homePersonalizedCache.sig === historySig;

    if (canUseCache) {
      renderPersonalizedRows(homePersonalizedCache.rows || []);
      return;
    }

    if (!force && homePersonalizedInFlight) {
      if (!preferCache) {
        container.innerHTML = '<div class="loading-spinner" style="grid-column: 1 / -1; padding: 30px 0;"><div class="spinner"></div></div>';
      }
      await homePersonalizedInFlight;
      return;
    }

    if (!preferCache || !homePersonalizedCache || homePersonalizedCache.sig !== historySig) {
      container.innerHTML = '<div class="loading-spinner" style="grid-column: 1 / -1; padding: 30px 0;"><div class="spinner"></div></div>';
    } else {
      renderPersonalizedRows(homePersonalizedCache.rows || []);
    }

    homePersonalizedInFlight = (async () => {
      try {
        const res = await fetch('/api/recommend', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ history: state.listeningHistory.slice(-50) })
        });
        const data = await res.json();
        const results = Array.isArray(data.results) ? data.results : [];
        homePersonalizedCache = { rows: results, t: Date.now(), sig: historySig };
        renderPersonalizedRows(results);
      } catch (err) {
        if (!homePersonalizedCache || homePersonalizedCache.sig !== historySig) {
          container.innerHTML = `<div class="empty-state small" style="grid-column: 1 / -1;">
            <p>Không tải được gợi ý cá nhân</p>
          </div>`;
        }
      } finally {
        homePersonalizedInFlight = null;
      }
    })();

    await homePersonalizedInFlight;
  }

  function renderSongCard(song) {
    return `
      <div class="song-card" data-id="${song.videoId}">
        <img class="song-card-thumb" src="${song.thumbnail}" alt="" loading="lazy">
        <div class="song-card-overlay">
          <div class="song-card-play">
            <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
          </div>
        </div>
        <span class="song-card-duration">${fmtDur(song.duration)}</span>
        <div class="song-card-info">
          <div class="song-card-title">${esc(song.title)}</div>
          <div class="song-card-artist">${esc(song.author)}</div>
        </div>
      </div>`;
  }

  /** Top cộng đồng: trong phòng chỉ thêm hàng chờ phòng; ngoài phòng phát luôn. */
  function bindCommunityChartCards(container) {
    container.onclick = (e) => {
      const card = e.target.closest('.song-card');
      if (!card || !container.contains(card)) return;
      const durEl = card.querySelector('.song-card-duration');
      const song = {
        videoId: card.dataset.id,
        title: card.querySelector('.song-card-title')?.textContent || '',
        author: card.querySelector('.song-card-artist')?.textContent || '',
        thumbnail: card.querySelector('.song-card-thumb')?.src || '',
        duration: durEl ? parseDur(durEl.textContent) : 0,
      };
      if (roomCode) addToQueue(song);
      else playSong(song);
    };
  }

  function bindSongCards(container) {
    container.onclick = (e) => {
      const card = e.target.closest('.song-card');
      if (!card || !container.contains(card)) return;
      const durEl = card.querySelector('.song-card-duration');
      const song = {
        videoId: card.dataset.id,
        title: card.querySelector('.song-card-title')?.textContent || '',
        author: card.querySelector('.song-card-artist')?.textContent || '',
        thumbnail: card.querySelector('.song-card-thumb')?.src || '',
        duration: durEl ? parseDur(durEl.textContent) : 0,
      };
      playSong(song);
    };
  }

  // ── Playlists / Library ───────────────────────────────────────
  function renderPlaylists() {
    const container = $('#playlists-container');
    const existingPlaylists = container.querySelectorAll('.playlist-item:not(#btn-favorites)');
    existingPlaylists.forEach(el => el.remove());

    Object.keys(state.playlists).forEach(name => {
      const btn = document.createElement('button');
      btn.className = 'playlist-item';
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
        <span>${esc(name)}</span>
        <span class="playlist-count">${state.playlists[name].length}</span>`;
      btn.addEventListener('click', () => openPlaylistView(name));
      container.appendChild(btn);
    });
  }

  function setupModals() {
    const overlay = $('#modal-overlay');
    const content = $('#modal-content');

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.style.display = 'none';
    });

    $('#btn-create-playlist')?.addEventListener('click', () => {
      content.innerHTML = `
        <h3>Tạo Playlist Mới</h3>
        <input type="text" id="new-playlist-name" placeholder="Tên playlist..." autofocus>
        <div class="modal-actions">
          <button class="btn-text" id="modal-cancel">Hủy</button>
          <button class="btn-primary" id="modal-create" style="padding:8px 18px;">Tạo</button>
        </div>`;
      overlay.style.display = '';

      $('#modal-cancel').addEventListener('click', () => overlay.style.display = 'none');
      $('#modal-create').addEventListener('click', () => {
        const name = $('#new-playlist-name').value.trim();
        if (!name) return;
        if (state.playlists[name]) { toast('Playlist đã tồn tại', 'error'); return; }
        state.playlists[name] = [];
        saveState();
        renderPlaylists();
        overlay.style.display = 'none';
        toast(`Đã tạo playlist: ${name}`, 'success');
      });
      $('#new-playlist-name').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('#modal-create').click();
      });
    });
  }

  function showConfirmModal({
    title = 'Xác nhận',
    message = 'Bạn có chắc muốn tiếp tục?',
    confirmText = 'Đồng ý',
    cancelText = 'Hủy',
    danger = false
  } = {}) {
    return new Promise((resolve) => {
      const overlay = $('#modal-overlay');
      const content = $('#modal-content');
      if (!overlay || !content) return resolve(false);

      content.innerHTML = `
        <h3>${esc(title)}</h3>
        <p style="margin-top:8px;color:var(--text-secondary);line-height:1.5">${esc(message)}</p>
        <div class="modal-actions" style="margin-top:16px;display:flex;justify-content:flex-end;gap:10px;">
          <button class="btn-text" id="confirm-cancel">${esc(cancelText)}</button>
          <button class="${danger ? 'btn-text' : 'btn-primary'}" id="confirm-ok"
            style="${danger ? 'border:1px solid rgba(255,71,87,.5);color:#ff6b76;background:rgba(255,71,87,.08);padding:8px 14px;border-radius:999px;' : ''}">
            ${esc(confirmText)}
          </button>
        </div>`;

      const cleanupAndClose = (result) => {
        overlay.style.display = 'none';
        resolve(result);
      };

      overlay.style.display = '';
      $('#confirm-cancel')?.addEventListener('click', () => cleanupAndClose(false));
      $('#confirm-ok')?.addEventListener('click', () => cleanupAndClose(true));
      const onOverlayClick = (e) => {
        if (e.target === overlay) {
          overlay.removeEventListener('click', onOverlayClick);
          cleanupAndClose(false);
        }
      };
      overlay.addEventListener('click', onOverlayClick);
    });
  }

  let electronUpdaterUiWired = false;
  function setupElectronUpdaterUI() {
    if (!window.electronAPI?.onUpdateEvent || electronUpdaterUiWired) return;
    electronUpdaterUiWired = true;
    window.electronAPI.onUpdateEvent(async (ev) => {
      if (!ev || !ev.type) return;
      if (ev.type === 'dev-mode' && ev.message) {
        toast(ev.message, 'info');
        return;
      }
      if (ev.type === 'not-available' && ev.fromManual) {
        const rv = ev.remoteVersion ? ` · Server: v${ev.remoteVersion}` : '';
        toast(`Phiên bản trên máy: v${ev.version || '?'}${rv}`, 'success');
        return;
      }
      if (ev.type === 'downloaded') {
        const ok = await showConfirmModal({
          title: 'MiGu Music — Cập nhật đã tải xong',
          message: `MiGu Music v${ev.version || 'mới'} đã sẵn sàng. Khởi động lại để hoàn tất cài đặt?`,
          confirmText: 'Khởi động lại',
          cancelText: 'Để sau',
        });
        if (ok) window.electronAPI?.quitAndInstall?.();
        return;
      }
      if (ev.type === 'error') {
        await showConfirmModal({
          title: 'MiGu Music — Lỗi cập nhật',
          message: ev.message || 'Lỗi không xác định.',
          confirmText: 'Đóng',
          cancelText: 'Đóng',
        });
      }
    });
  }

  // ── Keyboard ──────────────────────────────────────────────────
  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const isGuest = roomCode && !isRoomHost;

      switch (e.key) {
        case ' ':
          if (isGuest) return;
          e.preventDefault();
          $('#np-btn-play')?.click();
          break;
        case 'ArrowRight':
          if (!canScrubTimeline()) return;
          if (audio.duration) {
            audio.currentTime = Math.min(audio.duration, audio.currentTime + 10);
            if (roomCode && isRoomHost) emitRoomState({ currentTime: audio.currentTime });
          }
          break;
        case 'ArrowLeft':
          if (!canScrubTimeline()) return;
          if (audio.duration) {
            audio.currentTime = Math.max(0, audio.currentTime - 10);
            if (roomCode && isRoomHost) emitRoomState({ currentTime: audio.currentTime });
          }
          break;
        case 'ArrowUp': e.preventDefault(); setVol(Math.min(100, state.volume + 5)); break;
        case 'ArrowDown': e.preventDefault(); setVol(Math.max(0, state.volume - 5)); break;
        case 'n': case 'N':
          if (isGuest) return;
          nextTrack();
          break;
        case 'p': case 'P':
          if (isGuest) return;
          prevTrack();
          break;
      }
    });

    function setVol(v) {
      state.volume = v;
      audio.volume = v / 100;
      $('#np-volume-slider').value = v;
      $('#pb-volume').value = v;
      saveState();
    }
  }

  // ── Idle Detection ────────────────────────────────────────────
  function setupIdleDetection() {
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
    events.forEach(ev => document.addEventListener(ev, resetIdle, { passive: true }));
    resetIdle();
  }

  function resetIdle() {
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      if (state.isPlaying && state.currentView !== 'nowplaying') switchView('nowplaying');
    }, state.idleTimeout);
  }

  // ── Media Session ─────────────────────────────────────────────
  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.setActionHandler('play', () => { audio.play(); state.isPlaying = true; updatePlayBtns(true); });
    navigator.mediaSession.setActionHandler('pause', () => { audio.pause(); state.isPlaying = false; updatePlayBtns(false); });
    navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack());
    navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack());
  }

  // ── Toast ─────────────────────────────────────────────────────
  function toast(msg, type = 'info') {
    const container = $('#toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  // ── Helpers ───────────────────────────────────────────────────
  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function fmtDur(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function parseDur(str) {
    if (!str) return 0;
    const parts = str.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return 0;
  }

  // ── Boot ──────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);
})();
