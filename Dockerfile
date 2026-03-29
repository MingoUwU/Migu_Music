# Use Node 22 (LTS) for modern dependency support
FROM node:22-bookworm-slim

WORKDIR /app

# Install system dependencies for node-gyp and others if needed
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies with engine check disabled if necessary, but Node 22 should be fine
RUN npm install

# Copy application source
COPY . .

# Ensure the server can find yt-dlp (it should be in node_modules)
# Environment variables for production
ENV NODE_ENV=production
ENV PORT=3000

# Expose the internal server port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
