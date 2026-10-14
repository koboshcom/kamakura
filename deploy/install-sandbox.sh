#!/bin/bash
set -euo pipefail
. /etc/os-release
case "$ID" in
  ubuntu|debian)
    apt-get update
    apt-get install -y --no-install-recommends ffmpeg sudo bash coreutils python3 python3-venv python3-tk git curl ca-certificates openssh-client netcat-openbsd \
    xvfb xfce4-session xfwm4 xfdesktop4 xfce4-panel xfce4-settings \
    dbus-x11 xauth x11-utils scrot fonts-dejavu-core xterm util-linux libxi6 libxtst6 libxrandr2 libxkbcommon0 at-spi2-core libatspi2.0-0 \
    x11vnc novnc websockify xclip xsel
    ;;
  fedora)
    # Full FFmpeg preserves H.264/AAC support used by the media tools.
    dnf install -y https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-44.noarch.rpm
    dnf install -y --setopt=install_weak_deps=False --allowerasing \
      ffmpeg sudo bash coreutils python3 python3-pip python3-tkinter git curl ca-certificates openssh-clients nmap-ncat \
      xorg-x11-server-Xvfb xfce4-session xfwm4 xfdesktop xfce4-panel xfce4-settings \
      dbus-x11 xorg-x11-xauth xdpyinfo scrot dejavu-sans-fonts xterm util-linux libXi libXtst libXrandr libxkbcommon at-spi2-core \
      x11vnc novnc python3-websockify xclip xsel alsa-lib atk at-spi2-atk cups-libs libdrm mesa-libgbm nss nspr pango \
      gcc python3-devel zlib-devel libjpeg-turbo-devel
    # Fedora's noVNC files use a different directory; keep the entrypoint unchanged.
    test -f /usr/share/novnc/vnc.html || { test -f /usr/share/novnc/vnc_lite.html; }
    ;;
  *) echo 'Unsupported sandbox distribution' >&2; exit 2 ;;
esac
python3 -m venv /opt/desktop-venv
/opt/desktop-venv/bin/pip install --no-cache-dir playwright==1.60.0 Pillow==11.3.0 'yt-dlp[curl-cffi]==2026.8.19' curl-cffi==0.15.0 m3u8==6.0.0 dhash==1.4
if [ "$ID" = fedora ]; then
  /opt/desktop-venv/bin/python -m playwright install chromium
  dnf clean all
else
  /opt/desktop-venv/bin/python -m playwright install --with-deps chromium
  rm -rf /var/lib/apt/lists/*
fi
chmod -R a+rX /opt/playwright
