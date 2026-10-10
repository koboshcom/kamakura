#!/usr/bin/env python3
"""Trusted, mount-free network sidecar. Never run in an owner filesystem."""
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import sys

V4_DENY = [
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
    '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
    '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15',
    '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3',
]
# Only global-unicast IPv6 is admitted. Transition/tunnel ranges must not
# smuggle private IPv4 through NAT64, 6to4, Teredo or mapped IPv6.
V6_DENY = ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20']

def addresses(value):
    return sorted(set(str(ipaddress.ip_address(x)) for x in value.split(',') if x))

def rules(core, extra):
    core = addresses(core)
    extra = addresses(extra)
    v4 = V4_DENY + [x + '/32' for x in core + extra if ':' not in x]
    v6 = V6_DENY + [x + '/128' for x in core + extra if ':' in x]
    lines = [
        'table inet kamakura_egress {',
        'set denied4 { type ipv4_addr; flags interval; auto-merge; elements = { ' + ', '.join(v4) + ' }; }',
        'set denied6 { type ipv6_addr; flags interval; auto-merge; elements = { ' + ', '.join(v6) + ' }; }',
        'chain output { type filter hook output priority -150; policy drop;',
        # Before Docker's DNS DNAT at -100. Arbitrary resolver-port shortcuts
        # are rejected. Loopback apps in this owner's namespace still work.
        'ip daddr 127.0.0.11 meta l4proto { tcp, udp } th dport 53 accept',
        'ip daddr 127.0.0.11 reject with icmpx type admin-prohibited',
        'oifname "lo" accept',
    ]
    for ip in core:
        family = 'ip6' if ':' in ip else 'ip'
        lines.append(f'{family} daddr {ip} tcp sport 6080 ct state established ct direction reply ct original proto-dst 6080 accept')
    lines += [
        'ip daddr @denied4 counter reject with icmpx type admin-prohibited',
        'ip6 daddr @denied6 counter reject with icmpx type admin-prohibited',
        # NDP only, not general link-local connectivity. Root has no NET_RAW.
        'icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit } ip6 hoplimit 255 accept',
        'meta nfproto ipv4 accept',
        'ip6 daddr 2000::/3 accept',
        'reject with icmpx type admin-prohibited',
        '}',
        'chain input { type filter hook input priority -150; policy drop;',
        'iifname "lo" accept',
        'ct state established,related accept',
        'icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-advert } ip6 hoplimit 255 accept',
    ]
    for ip in core:
        family = 'ip6' if ':' in ip else 'ip'
        lines.append(f'{family} saddr {ip} tcp dport 6080 accept')
    lines += ['}', 'chain forward { type filter hook forward priority -150; policy drop; }', '}']
    return '\n'.join(lines) + '\n'

def canonical(value):
    if isinstance(value, dict):
        return {k: canonical(v) for k, v in value.items() if k not in ('handle', 'index', 'packets', 'bytes')}
    if isinstance(value, list):
        return [canonical(x) for x in value]
    return value

def snapshot():
    data = json.loads(subprocess.check_output(['nft', '-j', 'list', 'table', 'inet', 'kamakura_egress'], text=True))
    # Version information isn't part of the ruleset.
    data['nftables'] = [x for x in data['nftables'] if 'metainfo' not in x]
    return json.dumps(canonical(data), sort_keys=True, separators=(',', ':'))

def namespace():
    return os.readlink('/proc/self/ns/net')

def check():
    expected = Path('/run/policy.json').read_text()
    actual = snapshot()
    if actual != expected or namespace() != Path('/run/namespace').read_text():
        raise RuntimeError('Egress policy changed; refusing owner admission')
    print(json.dumps({'policy': hashlib.sha256(actual.encode()).hexdigest(), 'namespace': namespace()}))

def main():
    if sys.argv[1:] == ['check']:
        check()
        return
    # Guard has no owner code and no listening control API. Policy completes
    # before any owner joins. Docker restart rebuilds it before readmission.
    # PID1 installs policy itself. The manager's explicit install call uses
    # the same trusted lock, so concurrent startup cannot double-install rules.
    with open('/run/install.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if Path('/run/policy.json').exists():
            check()
        else:
            policy = rules(os.environ.get('CORE_IPS', ''), os.environ.get('DENIED_IPS', ''))
            subprocess.run(['nft', '-f', '-'], input=policy, text=True, check=True)
            Path('/run/policy.json').write_text(snapshot())
            Path('/run/namespace').write_text(namespace())
            check()
    if sys.argv[1:] != ['install']:
        os.execvp('sleep', ['sleep', 'infinity'])

if __name__ == '__main__':
    main()
