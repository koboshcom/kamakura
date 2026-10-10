FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends nftables python3 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY deploy/egress-guard.py /opt/kamakura/egress-guard.py
ENTRYPOINT ["python3", "/opt/kamakura/egress-guard.py"]
