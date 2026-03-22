/* ═══════════════════════════════════════════════════════════════
   MiGu Music Player v2.0 — iOS 26 Liquid Glass Edition
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
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const audio = $('#audio-player');

  const SVG = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
  };

  // ── Greeting ──────────────────────────────────────────────────
  function setGreeting() {
    const hour = new Date().getHours();
    let text = 'Xin chào';
    let sub = 'Bắt đầu ngày mới với âm nhạc';
    
    if (hour >= 5 && hour < 11) {
      text = 'Chào buổi sáng! ☕️';
      sub = 'Bắt đầu ngày mới tràn đầy năng lượng';
    } else if (hour >= 11 && hour < 14) {
      text = 'Chào buổi trưa! 🍲';
      sub = 'Thư giãn một chút với âm nhạc nhé';
    } else if (hour >= 14 && hour < 18) {
      text = 'Chào buổi chiều! 🍵';
      sub = 'Tiếp thêm cảm hứng cho buổi chiều';
    } else {
      text = 'Chào buổi tối! 🌙';
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

  // ── Greeting ──────────────────────────────────────────────────
  function setGreeting() {
    const h = new Date().getHours();
    const el = $('#greeting-text');
    const sub = $('#greeting-sub');
    if (h < 12)      { el.textContent = 'Chào buổi sáng! 🎵'; sub.textContent = 'Bắt đầu ngày mới với âm nhạc'; }
    else if (h < 18)  { el.textContent = 'Chào buổi chiều! ☀️'; sub.textContent = 'Thưởng thức âm nhạc thôi nào'; }
    else              { el.textContent = 'Chào buổi tối! 🌙'; sub.textContent = 'Thư giãn với những giai điệu hay'; }
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
    if (addQ) {
      const idx = state.queue.findIndex(q => q.videoId === song.videoId);
      if (idx >= 0) state.currentIndex = idx;
      else { state.queue.push(song); state.currentIndex = state.queue.length - 1; }
    }

    state.currentSongInfo = song;
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
      loadRecommendations(song.videoId);
    } catch (err) {
      console.error('Play error:', err);
      toast('Không thể phát bài hát này', 'error');
    }

    saveState();
    renderQueue();
  }

  function updateUI(song) {
    $('#np-title').textContent = song.title || '---';
    $('#np-artist').textContent = song.author || '---';
    const art = $('#np-artwork');
    art.src = song.thumbnail || '';
    art.onerror = () => { art.src = ''; };

    $('#pb-title').textContent = song.title || '---';
    $('#pb-artist').textContent = song.author || '---';
    const pbT = $('#pb-thumb');
    pbT.src = song.thumbnail || '';
    pbT.onerror = () => { pbT.src = ''; };

    const isFav = state.favorites.some(f => f.videoId === song.videoId);
    updateFavBtns(isFav);

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title, artist: song.author,
        artwork: song.thumbnail ? [{ src: song.thumbnail, sizes: '512x512', type: 'image/jpeg' }] : []
      });
    }
  }

  function showBar(show) {
    const bar = $('#player-bar');
    if (show && state.currentView !== 'nowplaying') bar.style.display = '';
    else if (!show) bar.style.display = 'none';
  }

  function updatePlayBtns(playing) {
    const npBtn = $('#np-btn-play');
    const pbBtn = $('#pb-play');
    npBtn.innerHTML = playing ? SVG.pause : SVG.play;
    pbBtn.innerHTML = playing ? SVG.pause : SVG.play;
    const disc = $('#np-disc');
    if (playing) disc?.classList.add('spinning');
    else disc?.classList.remove('spinning');
  }

  function updateFavBtns(isFav) {
    const npFav = $('#np-toggle-fav');
    const pbFav = $('#pb-fav');
    if (npFav) { npFav.classList.toggle('is-fav', isFav); if (isFav) npFav.querySelector('svg')?.setAttribute('fill', 'var(--accent)'); else npFav.querySelector('svg')?.setAttribute('fill', 'none'); }
    if (pbFav) { pbFav.classList.toggle('is-fav', isFav); if (isFav) pbFav.querySelector('svg')?.setAttribute('fill', 'var(--accent)'); else pbFav.querySelector('svg')?.setAttribute('fill', 'none'); }
  }

  // ── Player Controls ───────────────────────────────────────────
  function setupPlayerControls() {
    const toggle = () => {
      if (!audio.src) return;
      if (state.isPlaying) {
        audio.pause();
        state.isPlaying = false;
        updatePlayBtns(false);
      } else {
        // updatePlayBtns must be called AFTER play() resolves
        audio.play().then(() => {
          state.isPlaying = true;
          updatePlayBtns(true);
        }).catch((err) => {
          console.warn('Play rejected:', err);
        });
      }
    };

    $('#np-btn-play')?.addEventListener('click', toggle);
    $('#pb-play')?.addEventListener('click', toggle);

    $('#np-btn-next')?.addEventListener('click', () => nextTrack());
    $('#np-btn-prev')?.addEventListener('click', () => prevTrack());
    $('#pb-next')?.addEventListener('click', () => nextTrack());
    $('#pb-prev')?.addEventListener('click', () => prevTrack());

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
      if (audio.duration) audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
    });

    // Progress seeking (PB)
    $('#pb-progress')?.addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      if (audio.duration) audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
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
      if (state.repeat === 'one') {
        audio.currentTime = 0;
        audio.play().then(() => { state.isPlaying = true; updatePlayBtns(true); });
      } else nextTrack();
    });

    audio.addEventListener('error', (e) => {
      console.error('Audio error:', e);
      toast('Lỗi phát nhạc. Đang thử lại...', 'error');
      setTimeout(() => {
        if (state.currentSongInfo) {
          audio.src = `/api/stream/${state.currentSongInfo.videoId}?t=${Date.now()}`;
          audio.load();
          audio.play().then(() => { state.isPlaying = true; updatePlayBtns(true); }).catch(() => {});
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
      saveState();
      toast('Đã xóa hàng chờ', 'info');
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
    if (!state.queue.some(q => q.videoId === song.videoId)) {
      state.queue.push(song);
      renderQueue();
      saveState();
    }
  }

  function renderQueue() {
    const list = $('#queue-container');
    if (!list) return;
    if (state.queue.length === 0) {
      list.innerHTML = '<div class="empty-state small"><p>Chưa có bài hát nào</p></div>';
      return;
    }

    list.innerHTML = state.queue.map((song, i) => `
      <div class="queue-item ${i === state.currentIndex ? 'active' : ''}" data-index="${i}">
        <span class="queue-item-index">${i === state.currentIndex ? '▶' : (i + 1)}</span>
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
        state.currentIndex = idx;
        playSong(state.queue[idx], false);
      });
    });

    list.querySelectorAll('.queue-item-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index);
        state.queue.splice(idx, 1);
        if (idx < state.currentIndex) state.currentIndex--;
        else if (idx === state.currentIndex) {
          if (state.queue.length === 0) {
            state.currentIndex = -1; audio.pause(); audio.src = '';
            state.isPlaying = false; updatePlayBtns(false); showBar(false);
          } else {
            state.currentIndex = Math.min(state.currentIndex, state.queue.length - 1);
            playSong(state.queue[state.currentIndex], false);
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
      switch (e.key) {
        case ' ': e.preventDefault(); $('#np-btn-play')?.click(); break;
        case 'ArrowRight': if (audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 10); break;
        case 'ArrowLeft':  if (audio.duration) audio.currentTime = Math.max(0, audio.currentTime - 10); break;
        case 'ArrowUp':    e.preventDefault(); setVol(Math.min(100, state.volume + 5)); break;
        case 'ArrowDown':  e.preventDefault(); setVol(Math.max(0, state.volume - 5)); break;
        case 'n': case 'N': nextTrack(); break;
        case 'p': case 'P': prevTrack(); break;
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
