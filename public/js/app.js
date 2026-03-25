/* ═══════════════════════════════════════════════════════════════
   MiGu Music Player v2.0.6 — iOS 26 Liquid Glass Edition
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
  };

  let socket = null;
  let roomCode = null;
  let isRoomHost = false;
  let isProcessingRoomSync = false;
  let syncHeartbeat = null;

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

  const SVG = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
  };

  // ── Permissions ───────────────────────────────────────────────
  function applyHostPermissions() {
    const isGuest = roomCode && !isRoomHost;

    // Disable interactions if guest (Only disable playback controls)
    const targetSelectors = [
      '#np-btn-play', '#np-btn-prev', '#np-btn-next', '#np-progress-bar',
      '#np-btn-shuffle', '#np-btn-repeat',
      '#pb-play', '#pb-prev', '#pb-next', '#pb-progress',
      '#room-btn-play', '#room-btn-prev', '#room-btn-next'
    ];

    targetSelectors.forEach(sel => {
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
    if (window.electronAPI && window.electronAPI.onUpdateMsg) {
      window.electronAPI.onUpdateMsg((msg) => toast(msg, 'info'));
    }
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
        console.log('[MiGu] Server connection: OK');
      }
    } catch (e) {
      console.error('[MiGu] Server health check failed');
      toast('Không thể kết nối đến máy chủ âm nhạc', 'error');
    }
  }

  function init() {
    checkServer();
    loadState();
    setupParticles();
    setupNavigation();
    setupSearch();
    setupPasteLink();
    setupPlayerControls();
    setupVolumeControls();
    setupKeyboardShortcuts();
    setupIdleDetection();
    setupModals();
    setupMediaSession();
    setupQueueTabs();
    setupRoom(); // Initialize socket
    setupVisualizer(); // Initialize Web Audio API
    loadTrending();
    renderPlaylists();
    setGreeting();
    audio.volume = state.volume / 100;
    $('#fav-count').textContent = state.favorites.length;

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
      }
    } catch (e) { /* silent */ }
  }

  function saveState() {
    try {
      localStorage.setItem('migu_state', JSON.stringify({
        favorites: state.favorites,
        playlists: state.playlists,
        volume: state.volume,
        queue: state.queue,
        currentIndex: state.currentIndex,
        repeat: state.repeat,
        shuffle: state.shuffle,
      }));
    } catch (e) { /* silent */ }
  }

  // ── Room (Supabase Listen Together) ──────────────────────────────────
  function setupRoom() {
    if (typeof window.supabase === 'undefined') {
      console.warn('[MiGu] Supabase SDK not found. Room feature disabled.');
      return;
    }

    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
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
      hasShownSyncPrompt = false;
      if (globalLobbyChannel) globalLobbyChannel.untrack().catch(() => { });

      
      const tabRoom = $('#tab-room-queue');
      if (tabRoom) tabRoom.style.display = 'none';
      state.activeQueueTab = 'personal';
      $$('.queue-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'personal'));
      renderQueue();

      if (syncHeartbeat) { clearInterval(syncHeartbeat); syncHeartbeat = null; }
      $('#room-setup-panel').style.display = 'block';
      $('#room-active-panel').style.display = 'none';
      applyHostPermissions();
      updatePlayBtns(false);
      switchView('home');
      history.pushState({}, '', window.location.pathname);
      toast('Đã rời phòng', 'info');
    });

    $('#btn-copy-room-link')?.addEventListener('click', () => {
      const link = window.location.origin + window.location.pathname + '?room=' + roomCode;
      navigator.clipboard.writeText(link);
      toast('Đã copy link phòng', 'success');
    });

    $('#host-sync-mode')?.addEventListener('change', (e) => {
      if (isRoomHost) {
        emitRoomState({ syncMode: e.target.checked ? 'sync' : 'start' });
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
    isProcessingRoomSync = true;
    window.targetSyncTime = null; // Clear any old sync time

    if (syncHeartbeat) clearInterval(syncHeartbeat);
    syncHeartbeat = setInterval(() => {
      if (isRoomHost && roomChannel && roomCode) {
        emitRoomState();
      }
    }, 3000);

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


        // Host Election: earliest joined_at
        let hostId = null;
        let earliest = Infinity;
        for (const [key, presences] of Object.entries(presence)) {
          if (presences[0] && presences[0].joined_at < earliest) {
            earliest = presences[0].joined_at;
            hostId = key;
          }
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
          // Track joined_at for host election
          roomChannel.track({
            joined_at: earliest
          }).catch(() => {});

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
            joined_at: Date.now()
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
    const isPlaybackUpdate = update.currentSong !== undefined || update.isPlaying !== undefined || update.currentTime !== undefined;
    if (isPlaybackUpdate && window.currentRoomHostId && update.senderId !== window.currentRoomHostId) {
      console.warn(`[Sync] Ignoring playback update from non-host: ${update.senderId}`);
      return;
    }

    isProcessingRoomSync = true;

    if (update.queue !== undefined) {
      if (update.queue.length > state.roomQueue.length && state.roomQueue.length > 0) {
        const newSong = update.queue[update.queue.length - 1];
        if (newSong) toast(`Bài mới được thêm: ${newSong.title}`, 'success');
      }
      state.roomQueue = update.queue;
      if (state.activeQueueTab === 'room') renderQueue();
      renderRoomQueue();
    }

    if (update.currentSong !== undefined && update.currentSong !== null) {
      const isNewSong = !state.currentSongInfo || state.currentSongInfo.videoId !== update.currentSong.videoId;
      
      // Store target sync time for when metadata is loaded
      window.targetSyncTime = update.currentTime || 0;

      if (isNewSong) {
        state.currentIndex = update.queue ? update.queue.findIndex(q => q.videoId === update.currentSong.videoId) : state.currentIndex;
        state.currentSongInfo = update.currentSong;
        updateUI(update.currentSong);
        showBar(true);
        
        try {
          audio.src = '/api/stream/' + update.currentSong.videoId;
          audio.load();
          
          // Ensure we jump to time ONLY after metadata is ready
          audio.onloadedmetadata = () => {
             if (window.targetSyncTime !== null) {
                console.log(`[Sync] Metadata loaded, jumping to: ${window.targetSyncTime}s`);
                audio.currentTime = window.targetSyncTime;
                const t = window.targetSyncTime;
                window.targetSyncTime = null;
                if (update.isPlaying) {
                  audio.play().catch((err) => {
                    console.warn('[Sync] Autoplay blocked, showing prompt');
                    toast('Bấm Play để đồng bộ với Host', 'info');
                  });
                }
             }
          };
        } catch (e) { }
      } else if (window.targetSyncTime !== null) {
        // Same song, but we just joined and need to align to targetSyncTime
        console.log(`[Sync] Same song, immediate jump to: ${window.targetSyncTime}s`);
        audio.currentTime = window.targetSyncTime;
        window.targetSyncTime = null;
        if (update.isPlaying && audio.paused) {
          audio.play().catch(() => {
            console.warn('[Sync] Autoplay blocked on same-song join');
            toast('Bấm Play để đồng bộ với Host', 'info');
          });
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
          audio.play().catch(() => { });
        } else if (!update.isPlaying && !audio.paused) {
          audio.pause();
        }
        state.isPlaying = update.isPlaying;
        updatePlayBtns(update.isPlaying);
      }
      if (update.currentTime !== undefined && window.targetSyncTime === null) {
        // Only jump if deviation is significant (> 2.5s)
        const deviation = Math.abs(audio.currentTime - update.currentTime);
        if (deviation > 2.5) {
          console.log(`[Sync] Correcting drift from Host: ${deviation.toFixed(2)}s`);
          audio.currentTime = update.currentTime + 0.3; 
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

  function emitRoomState(partialState = {}, force = false) {
    if (!roomChannel || !roomCode || (isProcessingRoomSync && !force)) return;
    
    const update = {
      senderId: myUserId,
      queue: state.roomQueue,
      ...partialState
    };

    if (isRoomHost) {
      update.currentSong = state.currentSongInfo;
      update.isPlaying = state.isPlaying;
      update.currentTime = audio.currentTime;
      update.syncMode = $('#host-sync-mode')?.checked ? 'sync' : 'start';
      
      // ONLY the host broadcasts playback state to everyone
      roomChannel.send({ type: 'broadcast', event: 'room_state', payload: update });
    } else if (partialState.queue) {
      // Guests can ONLY broadcast queue updates (like adding a song)
      roomChannel.send({ type: 'broadcast', event: 'room_state', payload: { senderId: myUserId, queue: partialState.queue || state.roomQueue } });
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
    container.innerHTML = state.roomQueue.map((song, i) => `
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

    container.querySelectorAll('.q-room-up').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index);
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
      });
    });

    container.querySelectorAll('.q-room-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index);
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
      });
    });
  }


  // ── Particles ─────────────────────────────────────────────────
  function setupParticles() {
    const c = $('#particles');
    if (!c) return;
    for (let i = 0; i < 25; i++) {
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

    resetIdle();
  }

  // ── Search ────────────────────────────────────────────────────
  function setupSearch() {
    const input = $('#search-input');
    const clear = $('#search-clear');
    const sugBox = $('#suggestions-container');

    input.addEventListener('input', () => {
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
      results.innerHTML = '<div class="empty-state"><p>Lỗi tìm kiếm. Thử lại sau.</p></div>';
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

    if (addQ) {
      const q = (roomCode && isRoomHost) ? state.roomQueue : state.queue;
      const idx = q.findIndex(q => q.videoId === song.videoId);
      if (idx >= 0) state.currentIndex = idx;
      else { q.push(song); state.currentIndex = q.length - 1; }
    }

    state.currentSongInfo = song;
    updateUI(song);
    showBar(true);
    switchView('nowplaying');

    try {
      audio.src = `/api/stream/${encodeURIComponent(song.videoId)}`;
      if (isRoomHost) emitRoomState(); 
      audio.load();
      await audio.play();
      state.isPlaying = true;
      updatePlayBtns(true);
      $('#np-disc')?.classList.add('spinning');
      loadRecommendations(song.videoId);
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

  // ── Visualizer ────────────────────────────────────────────────
  let audioCtx = null;
  let analyser = null;
  let source = null;

  // Three.js Galaxy Variables
  let gScene, gCamera, gRenderer, gParticles, gGeometry, gMaterial, gCore;
  const starCount = 2800; // Even more stars!
  let mouseX = 0, mouseY = 0;
  let pulseIntensity = 0;

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

      if (state.visualizerMode === '3d') initGalaxy();
      drawVisualizer();
      window.removeEventListener('click', initCtx);
      window.removeEventListener('keydown', initCtx);
    };

    window.addEventListener('click', initCtx);
    window.addEventListener('keydown', initCtx);

    // Mouse movement for galaxy tilt
    window.addEventListener('mousemove', (e) => {
      const rect = $('#view-nowplaying')?.getBoundingClientRect();
      if (rect) {
        mouseX = (e.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
        mouseY = (e.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);
      }
    });

    $('#np-btn-menu')?.addEventListener('click', () => toggleVisualizerMode());

    // Initial UI state
    if (state.visualizerMode === '3d') {
      const container = $('.np-artwork-container');
      if (container) {
        container.style.opacity = '0';
        container.style.transform = 'scale(0.8)';
        container.style.pointerEvents = 'none';
      }
      $('#galaxy-container').style.display = 'block';
    }

    function drawVisualizer() {
      if (!analyser) return;
      requestAnimationFrame(drawVisualizer);

      // Only render if we are in Now Playing view AND it is visible
      const galaxy = $('#galaxy-container');
      if (state.currentView !== 'nowplaying' || !galaxy || galaxy.offsetWidth === 0) return;

      if (state.visualizerMode === '3d') {
        updateGalaxy();
        return;
      }

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

  function initGalaxy() {
    if (gRenderer) return;
    const container = $('#galaxy-container');
    const w = container.offsetWidth || 500;
    const h = container.offsetHeight || 500;

    gScene = new THREE.Scene();
    gCamera = new THREE.PerspectiveCamera(60, w / h, 0.1, 1000);
    gCamera.position.z = 6;

    gRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    gRenderer.setPixelRatio(window.devicePixelRatio);
    gRenderer.setSize(w, h);
    container.appendChild(gRenderer.domElement);

    // Create a circular glow texture
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(0.3, 'rgba(255, 255, 255, 0.9)');
    grad.addColorStop(0.6, 'rgba(255, 255, 255, 0.2)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    const texture = new THREE.CanvasTexture(canvas);

    gGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);
    const scales = new Float32Array(starCount);

    const spiralArms = 3;
    const armTightness = 0.5;

    for (let i = 0; i < starCount; i++) {
      const i3 = i * 3;
      const radius = Math.random() * 5;
      const spinAngle = radius * armTightness;
      const branchAngle = (i % spiralArms) / spiralArms * Math.PI * 2;

      const randomX = (Math.pow(Math.random(), 3) * (Math.random() < 0.5 ? 1 : -1) * 0.3) * radius;
      const randomY = (Math.pow(Math.random(), 3) * (Math.random() < 0.5 ? 1 : -1) * 0.3) * radius;
      const randomZ = (Math.pow(Math.random(), 3) * (Math.random() < 0.5 ? 1 : -1) * 0.3) * radius;

      positions[i3] = Math.cos(branchAngle + spinAngle) * radius + randomX;
      positions[i3 + 1] = randomY * 0.5;
      positions[i3 + 2] = Math.sin(branchAngle + spinAngle) * radius + randomZ;

      const mixedColor = new THREE.Color();
      const colorInside = new THREE.Color('#ff0099');
      const colorOutside = new THREE.Color('#00ccff');
      mixedColor.lerpColors(colorInside, colorOutside, radius / 5);

      colors[i3] = mixedColor.r;
      colors[i3 + 1] = mixedColor.g;
      colors[i3 + 2] = mixedColor.b;

      scales[i] = Math.random();
    }

    gGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    gGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    gMaterial = new THREE.PointsMaterial({
      size: 0.18,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      map: texture,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 1
    });

    gParticles = new THREE.Points(gGeometry, gMaterial);
    gScene.add(gParticles);

    // Create a BRIGHTER center star
    const coreGeom = new THREE.BufferGeometry();
    coreGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3));
    const coreMat = new THREE.PointsMaterial({
      size: 3.5, // Even bigger
      map: texture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      color: 0xffffff,
      depthWrite: false,
      opacity: 1
    });
    gCore = new THREE.Points(coreGeom, coreMat);
    gScene.add(gCore);

    // Robust Resize handling using ResizeObserver
    const ro = new ResizeObserver(() => {
      const w = container.offsetWidth || 500;
      const h = container.offsetHeight || 500;
      if (w > 0 && h > 0) {
        gRenderer.setSize(w, h);
        gCamera.aspect = w / h;
        gCamera.updateProjectionMatrix();
        console.log('[MiGu] 3D Visualizer Adaptive Resize:', w, 'x', h);
      }
    });
    ro.observe(container);
  }

  function updateGalaxy() {
    if (!analyser || !gParticles) return;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);

    let average = 0;
    for (let i = 0; i < 16; i++) average += dataArray[i]; // Bass
    average /= 16;

    // Bass Detection for "Supernova" Pulse
    if (average > 210) pulseIntensity = 1.0;
    else pulseIntensity *= 0.92; // Decay

    const lerpPulse = (average / 255);
    const targetScale = (1 + lerpPulse * 0.8) + pulseIntensity * 0.6;

    gParticles.scale.set(
      THREE.MathUtils.lerp(gParticles.scale.x, targetScale, 0.1),
      THREE.MathUtils.lerp(gParticles.scale.y, targetScale, 0.1),
      THREE.MathUtils.lerp(gParticles.scale.z, targetScale, 0.1)
    );

    // Dynamic Core Pulse & Color
    if (gCore) {
      gCore.material.size = 3.5 + pulseIntensity * 5; // Surge more!
      gCore.material.opacity = 1;

      // Lerp color between Pink and Cyan
      const c1 = new THREE.Color('#ff0099');
      const c2 = new THREE.Color('#00ccff');
      gCore.material.color.lerpColors(c1, c2, 0.5 + (Math.sin(Date.now() * 0.002) * 0.5));

      // More dramatic flash
      if (pulseIntensity > 0.7) gCore.material.color.set('#ffffff');
    }

    // Interaction & Rotation
    gParticles.rotation.y += 0.003 + lerpPulse * 0.02 + pulseIntensity * 0.05;

    // Mouse Gravity Tilt
    const targetRotX = 0.5 + lerpPulse * 0.3 + (mouseY * 0.4);
    const targetRotY = (mouseX * 0.4);

    gParticles.rotation.x = THREE.MathUtils.lerp(gParticles.rotation.x, targetRotX, 0.05);
    gParticles.rotation.z = THREE.MathUtils.lerp(gParticles.rotation.z, targetRotY, 0.05);

    gRenderer.render(gScene, gCamera);
  }

  function toggleVisualizerMode() {
    state.visualizerMode = state.visualizerMode === '2d' ? '3d' : '2d';
    localStorage.setItem('migu-vmode', state.visualizerMode);

    const disc = $('#np-disc');
    const galaxy = $('#galaxy-container');
    const container = $('.np-artwork-container');

    if (state.visualizerMode === '3d') {
      if (container) {
        container.style.opacity = '0';
        container.style.transform = 'scale(0.8)';
      }
      setTimeout(() => {
        if (disc) disc.style.display = 'none';
        galaxy.style.display = 'block';
        if (!gRenderer) initGalaxy();
        else {
          const w = galaxy.offsetWidth || 500;
          const h = galaxy.offsetHeight || 500;
          gRenderer.setSize(w, h);
          gCamera.aspect = w / h;
          gCamera.updateProjectionMatrix();
        }
      }, 500);
    } else {
      galaxy.style.display = 'none';
      if (disc) disc.style.display = 'flex';
      setTimeout(() => {
        if (container) {
          container.style.opacity = '1';
          container.style.transform = 'scale(1)';
        }
      }, 50);
    }
    toast(`Chế độ: ${state.visualizerMode === '3d' ? 'Vũ trụ 3D' : 'Đĩa xoay 2D'}`, 'info');
  }

  // ── Player Controls ───────────────────────────────────────────
  function setupPlayerControls() {
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

    // Progress seeking (NP)
    $('#np-progress-bar')?.addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      if (audio.duration) {
        audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
        emitRoomState({ currentTime: audio.currentTime });
      }
    });

    // Progress seeking (PB)
    $('#pb-progress')?.addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      if (audio.duration) {
        audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
        emitRoomState({ currentTime: audio.currentTime });
      }
    });

    // Audio events
    audio.addEventListener('timeupdate', () => {
      if (!audio.duration) return;
      const pct = (audio.currentTime / audio.duration) * 100;
      const npFill = $('#np-progress-fill');
      const pbFill = $('#pb-progress-fill');
      if (npFill) npFill.style.width = pct + '%';
      if (pbFill) pbFill.style.width = pct + '%';
      $('#np-current-time').textContent = fmtDur(audio.currentTime);
      $('#np-duration').textContent = fmtDur(audio.duration);
      $('#pb-time').textContent = `${fmtDur(audio.currentTime)} / ${fmtDur(audio.duration)}`;
    });

    audio.addEventListener('ended', () => {
      state.isPlaying = false;
      updatePlayBtns(false);
      emitRoomState({ isPlaying: false });
      if (state.repeat === 'one') {
        audio.currentTime = 0;
        audio.play().then(() => { state.isPlaying = true; updatePlayBtns(true); });
      } else nextTrack();
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
      const cur = state.queue[state.currentIndex];
      state.queue = cur ? [cur] : [];
      state.currentIndex = cur ? 0 : -1;
      renderQueue();
      if (roomCode) renderRoomQueue();
      saveState();
      toast('Đã xóa hàng chờ', 'info');
      emitRoomState({ queue: state.queue });
    });
  }

  function nextTrack() {
    if (state.queue.length === 0) return;
    if (state.shuffle) {
      let n; do { n = Math.floor(Math.random() * state.queue.length); } while (n === state.currentIndex && state.queue.length > 1);
      state.currentIndex = n;
    } else {
      state.currentIndex++;
      if (state.currentIndex >= state.queue.length) {
        if (state.repeat === 'all') state.currentIndex = 0;
        else { state.currentIndex = state.queue.length - 1; state.isPlaying = false; updatePlayBtns(false); return; }
      }
    }
    const song = state.queue[state.currentIndex];
    if (song) playSong(song, false);
  }

  function prevTrack() {
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (state.queue.length === 0) return;
    state.currentIndex = Math.max(0, state.currentIndex - 1);
    const song = state.queue[state.currentIndex];
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

    list.innerHTML = q.map((song, i) => `
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

    list.querySelectorAll('.queue-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.queue-item-remove')) return;
        const idx = parseInt(item.dataset.index);
        
        if (isRoom) {
          if (isRoomHost) playSong(state.roomQueue[idx], false);
          else toast('Chỉ Host mới có quyền chọn bài phát trực tiếp', 'info');
        } else {
          if (roomCode && isSyncActive()) {
            if (confirm('Dừng nghe chung để phát danh sách cá nhân?')) {
              window.userSyncChoice = 'start'; // "start" mode = unsynced local
              playSong(state.queue[idx], false);
            }
          } else {
            state.currentIndex = idx;
            playSong(state.queue[idx], false);
          }
        }
      });
    });

    list.querySelectorAll('.queue-item-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index);
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
      });
    });

    const active = list.querySelector('.queue-item.active');
    if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ── Favorites ─────────────────────────────────────────────────
  function toggleFav(song) {
    const idx = state.favorites.findIndex(f => f.videoId === song.videoId);
    if (idx >= 0) { state.favorites.splice(idx, 1); toast('Đã xóa khỏi yêu thích', 'info'); }
    else { state.favorites.unshift(song); toast('Đã thêm vào yêu thích ❤️', 'success'); }
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

    list.innerHTML = state.favorites.map(item => renderResultItem(item)).join('');
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
      listEl.innerHTML = songs.map(item => renderResultItem(item)).join('');
      bindResultActions(listEl);
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

    switchView('playlist');
  }

  // ── Recommendations ───────────────────────────────────────────
  async function loadRecommendations(videoId) {
    const container = $('#suggest-container');
    if (!container) return;
    container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

    try {
      const res = await fetch(`/api/info/${videoId}`);
      const data = await res.json();
      const recs = data.recommendedVideos || [];

      if (recs.length === 0) {
        container.innerHTML = '<div class="empty-state small"><p>Không có gợi ý</p></div>';
        return;
      }

      container.innerHTML = recs.map(v => `
        <div class="suggest-item" data-id="${v.videoId}">
          <img class="suggest-thumb" src="${v.thumbnail}" alt="" loading="lazy">
          <div class="suggest-info">
            <div class="suggest-title">${esc(v.title)}</div>
            <div class="suggest-artist">${esc(v.author)}</div>
          </div>
          <div class="suggest-actions">
            <button class="suggest-action-btn play" title="Phát" data-action="play">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </button>
            <button class="suggest-action-btn add" title="Thêm vào hàng chờ" data-action="add">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
          </div>
        </div>
      `).join('');

      container.querySelectorAll('.suggest-item').forEach(item => {
        const song = { videoId: item.dataset.id, title: item.querySelector('.suggest-title').textContent, author: item.querySelector('.suggest-artist').textContent, thumbnail: item.querySelector('.suggest-thumb').src, duration: 0 };
        item.querySelector('[data-action="play"]')?.addEventListener('click', (e) => { e.stopPropagation(); playSong(song); });
        item.querySelector('[data-action="add"]')?.addEventListener('click', (e) => { e.stopPropagation(); addToQueue(song); toast('Đã thêm vào hàng chờ', 'success'); });
        item.addEventListener('click', () => playSong(song));
      });
    } catch (err) {
      container.innerHTML = '<div class="empty-state small"><p>Không tải được gợi ý</p></div>';
    }
  }

  // ── Trending ──────────────────────────────────────────────────
  async function loadTrending() {
    const container = $('#trending-container');
    container.innerHTML = '<div class="loading-spinner" style="grid-column: 1 / -1; padding: 80px 0;"><div class="spinner"></div></div>';
    try {
      const res = await fetch('/api/trending');
      const data = await res.json();

      if (!data.results || data.results.length === 0) {
        container.innerHTML = '<div class="empty-state small"><p>Không tải được nhạc thịnh hành</p></div>';
        return;
      }

      container.innerHTML = data.results.map(song => renderSongCard(song)).join('');
      bindSongCards(container);
    } catch (err) {
      container.innerHTML = '<div class="empty-state small"><p>Không tải được nhạc thịnh hành</p></div>';
    }
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

  function bindSongCards(container) {
    container.querySelectorAll('.song-card').forEach(card => {
      card.addEventListener('click', () => {
        const song = {
          videoId: card.dataset.id,
          title: card.querySelector('.song-card-title').textContent,
          author: card.querySelector('.song-card-artist').textContent,
          thumbnail: card.querySelector('.song-card-thumb').src,
          duration: parseDur(card.querySelector('.song-card-duration').textContent)
        };
        playSong(song);
      });
    });
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
          if (isGuest) return;
          if (audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 10);
          break;
        case 'ArrowLeft':
          if (isGuest) return;
          if (audio.duration) audio.currentTime = Math.max(0, audio.currentTime - 10);
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
