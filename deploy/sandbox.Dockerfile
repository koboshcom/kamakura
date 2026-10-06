FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash coreutils python3 python3-venv python3-tk git curl ca-certificates \
    xvfb xfce4-session xfwm4 xfdesktop4 xfce4-panel xfce4-settings \
    dbus-x11 xauth x11-utils scrot fonts-dejavu-core xterm util-linux \
    && python3 -m venv /opt/desktop-venv \
    && /opt/desktop-venv/bin/pip install --no-cache-dir playwright==1.60.0 pyautogui==0.9.54 Pillow==11.3.0 \
    && /opt/desktop-venv/bin/python -m playwright install --with-deps chromium \
    && chmod -R a+rX /opt/playwright \
    && rm -rf /var/lib/apt/lists/*
# Ubuntu has uid 1000 already. Use the numeric identity consistently across volumes.
RUN mkdir -p /workspace /opt/kamakura && chown 1000:1000 /workspace
COPY deploy/desktop-worker.py deploy/desktop-client.py deploy/start-desktop.sh /opt/kamakura/
ENV HOME=/workspace DISPLAY=:99 XAUTHORITY=/tmp/kamakura.Xauthority PATH=/opt/desktop-venv/bin:$PATH
USER 1000:1000
WORKDIR /workspace
CMD ["bash", "/opt/kamakura/start-desktop.sh"]
