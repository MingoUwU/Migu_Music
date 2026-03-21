# MiGu Music Player 🎵

MiGu Music is a personal, ad-free music streaming desktop application with a beautiful "iOS 26 Liquid Glass" glassmorphism aesthetic. It fetches audio streams directly off YouTube and provides a seamless music listening experience with an ultra-premium UI.

## Features
- **Trải nghiệm Premium**: Giao diện trong suốt viền mờ cực đẹp mắt, dark mode hiện đại.
- **Dán Link & Play**: Copy link nhạc trên YouTube và dán vào app để phát luôn không cần tải.
- **Tìm kiếm Online**: Công cụ tìm kiếm YouTube tích hợp với Gợi ý tìm kiếm (Autocomplete).
- **Trình phát xịn xò**: Đĩa than xoay tròn khi hát nhạc, tự động phát danh sách gợi ý.
- **Quản lý Thư viện**: Thêm bài hát vào Yêu thích (Favorites) và tạo Playlist cá nhân thoải mái.
- **Hoạt động ngầm**: Thu nhỏ app xuống system tray (góc dưới màn hình Windows) để vừa làm việc vừa nghe nhạc.
- **Chất lượng cao**: Tự ưu tiên stream audio bitrate cao nhất (Opus 160kbps).
- **Thịnh hành**: Tự động lấy danh sách Top nhạc Trending tại Việt Nam mỗi ngày.

## Setup & Installation (Cài đặt Source Code)

Nếu bạn muốn tải mã nguồn về để vọc vạch:

1. **Yêu cầu máy tính cài đặt sẵn [Node.js](https://nodejs.org/)**
2. Mở thư mục code và chạy lệnh cài đặt thư viện:
   ```bash
   npm install
   ```
3. Chạy app ở chế độ phát triển (Development):
   ```bash
   npm start
   ```

## Build file EXE (Đóng gói cho máy khác cấu hình)
Nếu muốn đóng gói app lại dạng file cài đặt `.exe` để chia sẻ cho mọi người:
```bash
npm run build
```
Kết quả sẽ sinh ra file `MiGu Music Setup 2.0.0.exe` trong thư mục `dist/`.

## License
MIT License.
