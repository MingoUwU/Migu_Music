# <p align="center">🎵 MiGu Music Player</p>

<p align="center">
  <img src="public/banner.png" alt="MiGu Music Mockup" width="800">
</p>

<p align="center">
  <strong>Personal, Ad-Free, Ultra-Premium Music Streaming Experience</strong>
</p>

---

MiGu Music is a sophisticated desktop music application designed with a futuristic **"iOS 26 Liquid Glass"** glassmorphism aesthetic. It provides a seamless, high-quality music listening experience by streaming directly from YouTube, all within a beautiful, ultra-premium interface.

## ✨ Key Features

- 💎 **Premium UI**: Stunning "Liquid Glass" transparency with modern dark mode and smooth animations.
- 🤝 **Collaborative Rooms**: Create or join "Listen Together" rooms with real-time sync, chat, and reactions.
- 🔗 **Paste & Play**: Instantly play any YouTube link without the need for downloads.
- 🔍 **Integrated Search**: Built-in YouTube search engine with smart autocomplete suggestions.
- 💿 **Professional Player**: Iconic rotating vinyl disc visualizer and automatic smart song recommendations.
- 📂 **Library Management**: Curate your favorites and create custom playlists with ease.
- 📥 **System Tray Support**: Run the app in the background (Windows system tray) for uninterrupted listening.
- 🎧 **High-Fidelity Audio**: Automatically prioritizes the highest available audio bitrates (Opus 160kbps).
- 🔥 **Trending Hits**: Stay updated with daily trending music charts from Vietnam and globally.
- 🎮 **Discord RPC**: Show off what you're listening to with integrated Discord Rich Presence.
- 🚀 **Auto-Updates**: Never miss a feature with seamless background updates.

## 🤝 Collaborative Rooms (Listen Together)

MiGu Music features a powerful real-time collaboration engine powered by **Supabase**:

- **Synchronized Playback**: The Host's playback state (song, time, play/pause) is synced to all guests.
- **Interactive Lobby**: Browse and join public rooms or create private ones with password protection.
- **Social Interaction**: Built-in chat system and floating emoji reactions to share the vibe.
- **Host Permissions**: Dynamic host election and optional enforced sync modes for a managed experience.

## 🛠 Tech Stack

MiGu Music is built with modern web and desktop technologies:

- **Frontend**: HTML5, Vanilla CSS (Glassmorphism), JavaScript (ES6+).
- **Backend**: [Electron](https://www.electronjs.org/), [Express.js](https://expressjs.com/).
- **Real-time**: [Supabase](https://supabase.com/) for collaborative rooms and presence.
- **Engine**: [yt-dlp](https://github.com/yt-dlp/yt-dlp) for robust audio stream extraction.
- **RPC**: [discord-rpc](https://github.com/discordjs/RPC) for activity status.
- **Updater**: [electron-updater](https://www.electron.build/auto-update) for seamless distribution.

## ⚡ Performance Optimization

Specially tuned for efficiency on systems with 8GB RAM:
- Single-process renderer limit.
- Aggressive V8 garbage collection (`max-old-space-size=256`).
- Minimized Chromium overhead via site-isolation trials.
- Spellcheck and devtools optimizations to save ~30MB+ RAM.

## 📥 Getting Started

### For Users
Most users should download the latest installer from the [Releases](https://github.com/MingoUwU/Migu_Music/releases) page.

### For Developers
If you wish to contribute or explore the source code:

1.  **Prerequisites**: Ensure you have [Node.js](https://nodejs.org/) installed.
2.  **Install Dependencies**:
    ```bash
    npm install
    ```
3.  **Run in Development**:
    ```bash
    npm start
    ```
4.  **Build Executable**:
    ```bash
    npm run build
    ```

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

<p align="center">
  Made with ❤️ by <strong>TrungNam</strong>
</p>

