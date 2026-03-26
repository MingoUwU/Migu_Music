# Sử dụng Node.js LTS
FROM node:20-slim

# Cài đặt Python3 và yt-dlp
RUN apt-get update && \
    apt-get install -y python3 ffmpeg curl && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Thư mục làm việc
WORKDIR /app

# Cài dependencies
COPY package*.json ./
RUN npm install --production

# Copy source code (bỏ qua node_modules qua .dockerignore)
COPY . .

# Port
ENV PORT=3000
EXPOSE 3000

# Khởi động server
CMD ["node", "server.js"]
