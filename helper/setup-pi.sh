#!/usr/bin/env bash
# Sets up the ARAN+ helper on a Raspberry Pi (Raspberry Pi OS, 64-bit) so it starts with
# the Pi and keeps running: FFmpeg, Node.js 22, the helper's one package, the helper's
# address in personal.json, and a service. Run it from the repo folder:
#
#   bash helper/setup-pi.sh
#
# It needs personal.json from the PC first (the provider's login and the helper's key),
# and says how to copy it over when it isn't there. Run it again after git pull: it
# installs only what's missing and starts the helper again.

set -euo pipefail
cd "$(dirname "$0")/.."
repo="$(pwd)"
me="$(id -un)"
here="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$here" ] || here="<this Pi's address>"

step() { printf '\n== %s\n' "$*"; }

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as your usual user, not with sudo: it asks for sudo itself when it needs it."
  exit 1
fi

if [ ! -f personal.json ]; then
  echo
  echo "First copy personal.json (your provider's login and the helper's key) from the PC."
  echo "On the PC, open PowerShell in the Samsung-IPTV-Player folder and run:"
  echo
  echo "  scp personal.json $me@$here:$repo/"
  echo
  echo "Then run this again:  bash helper/setup-pi.sh"
  exit 1
fi
# It holds the provider's password: for this user's eyes only.
chmod 600 personal.json

if ! command -v ffmpeg >/dev/null 2>&1; then
  step "Installing FFmpeg"
  sudo apt-get update
  sudo apt-get install -y ffmpeg
fi

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! command -v node >/dev/null 2>&1 || [ "$(node_major)" -lt 22 ]; then
  arch="$(dpkg --print-architecture)"
  if [ "$arch" != "arm64" ] && [ "$arch" != "amd64" ]; then
    echo "The helper needs Node.js 22, which needs the 64-bit Raspberry Pi OS (this one is $arch)."
    echo "Put the 64-bit one on the card with Raspberry Pi Imager, then run this again."
    exit 1
  fi
  step "Installing Node.js 22"
  sudo apt-get install -y ca-certificates curl
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

step "Installing the helper's package"
npm ci --omit=dev --no-audit --no-fund

step "Pointing the helper's address at this Pi"
node helper/address.mjs
url="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("personal.json", "utf8")).transcoder.url)')"
host="$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$url")"

step "Starting the helper as a service"
# TMPDIR: the pieces made for the phone and the Roku go on the card (/var/tmp), not in
# memory, which is where /tmp is on newer Raspberry Pi OS.
sudo tee /etc/systemd/system/aranplus-helper.service >/dev/null <<EOF
[Unit]
Description=ARAN+ helper (converts videos for the TV, the Roku and the iPhone)
Wants=network-online.target
After=network-online.target

[Service]
User=$me
WorkingDirectory=$repo
Environment=TMPDIR=/var/tmp
ExecStart=$(command -v node) helper/aranplus-helper.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable aranplus-helper >/dev/null 2>&1
since="$(date '+%Y-%m-%d %H:%M:%S')"
sudo systemctl restart aranplus-helper
sleep 4
echo
sudo journalctl -u aranplus-helper --since "$since" --no-pager -o cat || true

echo
if systemctl is-active --quiet aranplus-helper; then
  echo "The helper is running, and starts by itself whenever the Pi does."
else
  echo "The helper didn't start; what it said is above. Fix that and run this again."
  exit 1
fi
echo
echo "Next, on the PC, in the Samsung-IPTV-Player folder:"
echo "  1. Close the helper's window there (and take its shortcut out of the Startup folder)."
echo "  2. npm run helper:address -- $host"
echo "  3. npm run install:tv"
echo
echo "Give this Pi a fixed address ($host) in your router, so the TV keeps finding it."
echo "To watch what it's doing:  journalctl -u aranplus-helper -f"
echo "After a git pull here:     bash helper/setup-pi.sh"
