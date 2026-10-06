#!/bin/sh
# Root-only operator hook. Does not alter any Docker-managed chains.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run as root' >&2; exit 1; }
CORE_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' kamakura-core-1)
case "$CORE_IP" in 172.18.*) ;; *) echo 'Unexpected primary core address; configure rules manually' >&2; exit 1;; esac
ip link show kroot0 >/dev/null 2>&1 || ip link add kroot0 type bridge
ip address show dev kroot0 | grep -q '172.29.0.1/24' || ip address add 172.29.0.1/24 dev kroot0
ip link set kroot0 up
rule() {
  table=$1; chain=$2; shift 2
  iptables -t "$table" -C "$chain" "$@" 2>/dev/null || iptables -t "$table" -I "$chain" 1 "$@"
}
# Raw direct-routing rules from the primary daemon otherwise block return traffic.
rule raw PREROUTING -i kroot0 -d "$CORE_IP/32" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
rule filter FORWARD -s "$CORE_IP/32" -o kroot0 -p tcp --dport 6080 -j ACCEPT
rule filter FORWARD -i kroot0 -d "$CORE_IP/32" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
rule filter FORWARD -i kroot0 -o eth0 -s 172.29.0.0/24 -j ACCEPT
rule filter FORWARD -i eth0 -o kroot0 -d 172.29.0.0/24 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
# Stop legacy Docker rules from opening new connections to other bridges/boxes.
# Replies to core are explicitly allowed above; ordinary Internet egress uses eth0.
rule filter FORWARD -i kroot0 ! -o eth0 -m conntrack --ctstate NEW -j DROP
rule filter FORWARD -i kroot0 -m conntrack --ctstate INVALID -j DROP
# Backend credentials still protect HTTP+WS on every box.
rule nat POSTROUTING -s 172.29.0.0/24 -o eth0 -j MASQUERADE
sysctl -q -w net.ipv4.ip_forward=1
