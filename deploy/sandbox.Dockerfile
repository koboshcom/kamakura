FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
    sudo bash coreutils python3 python3-venv python3-tk git curl ca-certificates openssh-client netcat-openbsd \
    xvfb xfce4-session xfwm4 xfdesktop4 xfce4-panel xfce4-settings \
    dbus-x11 xauth x11-utils scrot fonts-dejavu-core xterm util-linux libxi6 libxtst6 libxrandr2 at-spi2-core libatspi2.0-0 \
    x11vnc novnc websockify \
    && python3 -m venv /opt/desktop-venv \
    && /opt/desktop-venv/bin/pip install --no-cache-dir playwright==1.60.0 Pillow==11.3.0 \
    && /opt/desktop-venv/bin/python -m playwright install --with-deps chromium \
    && chmod -R a+rX /opt/playwright \
    && rm -rf /var/lib/apt/lists/*
# Official Cua Driver binary-only release, pinned and verified before extraction.
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x86_64; sha=629ac96eff829d4dfd5cf221f3f2165c2d813aed91e5efb7b20777a741cd70a7 ;; \
      arm64) arch=arm64; sha=9db8b9084add57eb97be8164367b24b6be54ed4f3dc01213e64b72d7fc09fddb ;; \
      *) echo 'Unsupported Cua Driver architecture' >&2; exit 1 ;; \
    esac; \
    curl --fail --location --retry 3 "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.34.0/cua-driver-rs-0.34.0-linux-${arch}-binary.tar.gz" -o /tmp/cua-driver.tar.gz; \
    echo "${sha}  /tmp/cua-driver.tar.gz" | sha256sum --check; \
    mkdir -p /opt/cua-driver; \
    tar -xzf /tmp/cua-driver.tar.gz -C /opt/cua-driver; \
    ln -s /opt/cua-driver/cua-driver /usr/local/bin/cua-driver; \
    chmod -R a+rX /opt/cua-driver; \
    rm /tmp/cua-driver.tar.gz; \
    cua-driver --version
# Pinned official release, verified per architecture. No tunnel starts automatically.
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=amd64; sha=d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db ;; \
      arm64) arch=arm64; sha=e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08 ;; \
      *) echo 'Unsupported cloudflared architecture' >&2; exit 1 ;; \
    esac; \
    curl --fail --location --retry 3 "https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-linux-${arch}" -o /tmp/cloudflared; \
    echo "${sha}  /tmp/cloudflared" | sha256sum --check; \
    install -m 0755 /tmp/cloudflared /usr/local/bin/cloudflared; \
    rm /tmp/cloudflared; \
    cloudflared --version
# Ubuntu has uid 1000 already. Use the numeric identity consistently across volumes.
RUN mkdir -p /work /opt/kamakura && chown 1000:1000 /work \
    && printf 'ubuntu ALL=(ALL:ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/kamakura \
    && chmod 0440 /etc/sudoers.d/kamakura && visudo -cf /etc/sudoers.d/kamakura
COPY deploy/desktop-worker.py deploy/desktop-client.py deploy/start-desktop.sh deploy/file-tools.py /opt/kamakura/
ENV HOME=/work DISPLAY=:99 XAUTHORITY=/tmp/kamakura.Xauthority PATH=/opt/desktop-venv/bin:$PATH
USER 1000:1000
WORKDIR /work
CMD ["bash", "/opt/kamakura/start-desktop.sh"]
