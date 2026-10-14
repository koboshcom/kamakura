FROM ubuntu:24.04 AS sandbox-binaries
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
# Official Cua Driver binary-only release, pinned and verified before extraction.
RUN set -eu; \
    case "$(uname -m)" in \
      x86_64) arch=x86_64; sha=629ac96eff829d4dfd5cf221f3f2165c2d813aed91e5efb7b20777a741cd70a7 ;; \
      aarch64) arch=arm64; sha=9db8b9084add57eb97be8164367b24b6be54ed4f3dc01213e64b72d7fc09fddb ;; \
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
    case "$(uname -m)" in \
      x86_64) arch=amd64; sha=d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db ;; \
      aarch64) arch=arm64; sha=e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08 ;; \
      *) echo 'Unsupported cloudflared architecture' >&2; exit 1 ;; \
    esac; \
    curl --fail --location --retry 3 "https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-linux-${arch}" -o /tmp/cloudflared; \
    echo "${sha}  /tmp/cloudflared" | sha256sum --check; \
    install -m 0755 /tmp/cloudflared /usr/local/bin/cloudflared; \
    rm /tmp/cloudflared; \
    cloudflared --version

FROM debian:13.7-slim AS sandbox-debian
ARG SANDBOX_DISTRO=debian
RUN test "$SANDBOX_DISTRO" = debian || { echo 'Unsupported or mismatched SANDBOX_DISTRO; choose ubuntu, debian or fedora and the matching sandbox target' >&2; exit 2; }
ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
COPY deploy/install-sandbox.sh /tmp/install-sandbox.sh
RUN bash /tmp/install-sandbox.sh && rm /tmp/install-sandbox.sh
COPY --from=sandbox-binaries /opt/cua-driver /opt/cua-driver
COPY --from=sandbox-binaries /usr/local/bin/cloudflared /usr/local/bin/cloudflared
RUN ln -s /opt/cua-driver/cua-driver /usr/local/bin/cua-driver \
    && (getent group 1000 >/dev/null || groupadd -g 1000 ubuntu) \
    && (getent passwd 1000 >/dev/null || useradd -u 1000 -g 1000 -m ubuntu) \
    && mkdir -p /work /opt/kamakura && chown 1000:1000 /work \
    && printf '%s ALL=(ALL:ALL) NOPASSWD:ALL\n' "$(getent passwd 1000 | cut -d: -f1)" > /etc/sudoers.d/kamakura \
    && chmod 0440 /etc/sudoers.d/kamakura && visudo -cf /etc/sudoers.d/kamakura
COPY deploy/desktop-worker.py deploy/desktop-client.py deploy/start-desktop.sh deploy/file-tools.py deploy/video-link.py deploy/instagram-post.py /opt/kamakura/
ENV HOME=/work DISPLAY=:99 XAUTHORITY=/tmp/kamakura.Xauthority PATH=/opt/desktop-venv/bin:$PATH
USER 0:0
WORKDIR /work
CMD ["bash", "/opt/kamakura/start-desktop.sh"]

FROM fedora:44 AS sandbox-fedora
ARG SANDBOX_DISTRO=fedora
RUN test "$SANDBOX_DISTRO" = fedora || { echo 'Unsupported or mismatched SANDBOX_DISTRO; choose ubuntu, debian or fedora and the matching sandbox target' >&2; exit 2; }
ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
COPY deploy/install-sandbox.sh /tmp/install-sandbox.sh
RUN bash /tmp/install-sandbox.sh && rm /tmp/install-sandbox.sh
COPY --from=sandbox-binaries /opt/cua-driver /opt/cua-driver
COPY --from=sandbox-binaries /usr/local/bin/cloudflared /usr/local/bin/cloudflared
RUN ln -s /opt/cua-driver/cua-driver /usr/local/bin/cua-driver \
    && (getent group 1000 >/dev/null || groupadd -g 1000 ubuntu) \
    && (getent passwd 1000 >/dev/null || useradd -u 1000 -g 1000 -m ubuntu) \
    && mkdir -p /work /opt/kamakura && chown 1000:1000 /work \
    && printf '%s ALL=(ALL:ALL) NOPASSWD:ALL\n' "$(getent passwd 1000 | cut -d: -f1)" > /etc/sudoers.d/kamakura \
    && chmod 0440 /etc/sudoers.d/kamakura && visudo -cf /etc/sudoers.d/kamakura
COPY deploy/desktop-worker.py deploy/desktop-client.py deploy/start-desktop.sh deploy/file-tools.py deploy/video-link.py deploy/instagram-post.py /opt/kamakura/
ENV HOME=/work DISPLAY=:99 XAUTHORITY=/tmp/kamakura.Xauthority PATH=/opt/desktop-venv/bin:$PATH
USER 0:0
WORKDIR /work
CMD ["bash", "/opt/kamakura/start-desktop.sh"]

FROM ubuntu:24.04 AS sandbox-ubuntu
ARG SANDBOX_DISTRO=ubuntu
RUN test "$SANDBOX_DISTRO" = ubuntu || { echo 'Unsupported or mismatched SANDBOX_DISTRO; choose ubuntu, debian or fedora and the matching sandbox target' >&2; exit 2; }
ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
COPY deploy/install-sandbox.sh /tmp/install-sandbox.sh
RUN bash /tmp/install-sandbox.sh && rm /tmp/install-sandbox.sh
COPY --from=sandbox-binaries /opt/cua-driver /opt/cua-driver
COPY --from=sandbox-binaries /usr/local/bin/cloudflared /usr/local/bin/cloudflared
RUN ln -s /opt/cua-driver/cua-driver /usr/local/bin/cua-driver \
    && (getent group 1000 >/dev/null || groupadd -g 1000 ubuntu) \
    && (getent passwd 1000 >/dev/null || useradd -u 1000 -g 1000 -m ubuntu) \
    && mkdir -p /work /opt/kamakura && chown 1000:1000 /work \
    && printf '%s ALL=(ALL:ALL) NOPASSWD:ALL\n' "$(getent passwd 1000 | cut -d: -f1)" > /etc/sudoers.d/kamakura \
    && chmod 0440 /etc/sudoers.d/kamakura && visudo -cf /etc/sudoers.d/kamakura
COPY deploy/desktop-worker.py deploy/desktop-client.py deploy/start-desktop.sh deploy/file-tools.py deploy/video-link.py deploy/instagram-post.py /opt/kamakura/
ENV HOME=/work DISPLAY=:99 XAUTHORITY=/tmp/kamakura.Xauthority PATH=/opt/desktop-venv/bin:$PATH
USER 0:0
WORKDIR /work
CMD ["bash", "/opt/kamakura/start-desktop.sh"]
