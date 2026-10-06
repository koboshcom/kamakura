FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash coreutils python3 python3-venv git curl ca-certificates && rm -rf /var/lib/apt/lists/*
# Docker copies ownership into a newly-created named volume at first mount.
RUN mkdir -p /workspace && chown 1000:1000 /workspace
USER 1000:1000
ENV HOME=/workspace
WORKDIR /workspace
CMD ["sleep", "infinity"]
