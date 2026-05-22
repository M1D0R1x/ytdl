#!/usr/bin/env bash
set -e
echo "▸ neon-ytdl setup"

OS="$(uname -s)"
have() { command -v "$1" >/dev/null 2>&1; }

install_mac() {
  have brew || { echo "install Homebrew first: https://brew.sh"; exit 1; }
  brew install yt-dlp ffmpeg aria2
}
install_apt() {
  sudo apt-get update
  sudo apt-get install -y ffmpeg aria2 python3-pip curl
  sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  sudo chmod a+rx /usr/local/bin/yt-dlp
}
install_winget() {
  winget install --id yt-dlp.yt-dlp -e
  winget install --id Gyan.FFmpeg -e
  winget install --id aria2.aria2 -e
}

case "$OS" in
  Darwin) install_mac ;;
  Linux)  if have apt-get; then install_apt; else echo "use your package manager to install yt-dlp ffmpeg aria2"; fi ;;
  MINGW*|MSYS*|CYGWIN*) install_winget ;;
  *) echo "unknown OS: $OS — install yt-dlp, ffmpeg, aria2 manually"; ;;
esac

echo "▸ installing node deps"
npm install
(cd server && npm install)
(cd client && npm install)

echo "▸ done. start redis, then: npm run dev"
