#!/usr/bin/env python3
"""Root-only dedicated sandbox network policy. Run after every core recreation.
No live action occurs until an operator invokes this script. Docker-managed
chains are not flushed. Dedicated daemon must have iptables/ip6tables disabled.
"""
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess

def run(*args):
    return subprocess.check_output(args, text=True).strip()

def policy_rules(core, subnet, bridge, wan):
    denied = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3']
    rules = [['-i', bridge, '-m', 'conntrack', '--ctstate', 'INVALID', '-j', 'DROP'],
             ['-i', bridge, '-d', core, '-p', 'tcp', '--sport', '6080', '-m', 'conntrack', '--ctstate', 'ESTABLISHED', '-j', 'ACCEPT']]
    rules += [['-i', bridge, '-d', net, '-j', 'DROP'] for net in denied]
    rules += [['-i', bridge, '-o', wan, '-s', subnet, '-j', 'ACCEPT'],
              ['-i', bridge, '-j', 'DROP'],
              ['-s', core, '-o', bridge, '-d', subnet, '-p', 'tcp', '--dport', '6080', '-j', 'ACCEPT'],
              ['-i', wan, '-o', bridge, '-d', subnet, '-m', 'conntrack', '--ctstate', 'RELATED,ESTABLISHED', '-j', 'ACCEPT'],
              ['-o', bridge, '-j', 'DROP']]
    return rules

def install(tool, table, chain, rules, parent):
    subprocess.run([tool, '-w', '-t', table, '-N', chain], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # Install a guard before replacing our own chain, closing the transient gap.
    guard = [tool, '-w', '-t', table, '-I', parent, '1', '-i', BRIDGE, '-j', 'DROP']
    subprocess.check_call(guard)
    try:
        subprocess.check_call([tool, '-w', '-t', table, '-F', chain])
        for rule in rules:
            subprocess.check_call([tool, '-w', '-t', table, '-A', chain, *rule])
        check = [tool, '-w', '-t', table, '-C', parent, '-j', chain]
        while subprocess.run(check, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            subprocess.check_call([tool, '-w', '-t', table, '-D', parent, '-j', chain])
        subprocess.check_call([tool, '-w', '-t', table, '-I', parent, '1', '-j', chain])
    finally:
        # Failure retains the guard, deliberately failing closed.
        pass
    subprocess.check_call([tool, '-w', '-t', table, '-D', parent, '-i', BRIDGE, '-j', 'DROP'])

def main():
    global BRIDGE
    if os.geteuid() != 0:
        raise SystemExit('Run as root')
    instance = os.environ.get('SANDBOX_INSTANCE', 'default')
    name = os.environ.get('SANDBOX_NETWORK_NAME', f'kamakura-{instance}-sandboxes')
    BRIDGE = os.environ.get('SANDBOX_NETWORK_BRIDGE', 'ks' + hashlib.sha256(name.encode()).hexdigest()[:12])
    wan = os.environ.get('SANDBOX_EGRESS_INTERFACE') or run('ip', '-4', 'route', 'show', 'default').split(' dev ')[1].split()[0]
    if not re.fullmatch(r'[a-z0-9-]{1,32}', instance) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}', name) or any(not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,14}', x) for x in (BRIDGE, wan)):
        raise SystemExit('Invalid network names')
    subnet = str(ipaddress.IPv4Network(os.environ.get('SANDBOX_NETWORK_SUBNET', '172.30.0.0/24')))
    gateway = str(next(ipaddress.IPv4Network(subnet).hosts()))
    socket = os.environ.get('DOCKER_SOCKET_PATH', '/var/run/kamakura-root-docker.sock')
    docker = ['docker', '-H', 'unix://' + socket]
    core_name = os.environ.get('KAMAKURA_CORE_CONTAINER', 'kamakura-core-1')
    core_network = os.environ.get('KAMAKURA_CORE_NETWORK', 'kamakura_default')
    core_info = json.loads(run('docker', 'inspect', core_name))[0]
    core = str(ipaddress.IPv4Address(core_info['NetworkSettings']['Networks'][core_network]['IPAddress']))
    root = Path(os.environ.get('SANDBOX_ROOT', '/opt/kamakura/sandboxes')).absolute()
    if not root.is_dir() or root.resolve() != root:
        raise SystemExit('Workspace root must exist without symlinks')
    for path in [root, *root.parents]:
        st = path.stat()
        if st.st_uid != 0 or st.st_mode & 0o022:
            raise SystemExit('Unsafe workspace root ancestors')
    marker = root / '.network-policy.json'
    marker.unlink(missing_ok=True)
    found = subprocess.run([*docker, 'network', 'inspect', name], capture_output=True, text=True)
    if found.returncode:
        run(*docker, 'network', 'create', '--driver', 'bridge', '--subnet', subnet, '--gateway', gateway,
            '--opt', 'com.docker.network.bridge.name=' + BRIDGE, '--opt', 'com.docker.network.bridge.enable_icc=false',
            '--label', 'kamakura.network-policy=public-only-v1', '--label', 'kamakura.sandbox=' + instance, name)
    info = json.loads(run(*docker, 'network', 'inspect', name))[0]
    if info['Driver'] != 'bridge' or info.get('EnableIPv6') or info.get('Internal') or info['IPAM']['Config'] != [{'Subnet': subnet, 'Gateway': gateway}] or info.get('Options', {}).get('com.docker.network.bridge.name') != BRIDGE or info.get('Options', {}).get('com.docker.network.bridge.enable_icc') != 'false' or info.get('Labels', {}).get('kamakura.network-policy') != 'public-only-v1' or info.get('Labels', {}).get('kamakura.sandbox') != instance:
        raise SystemExit('Existing network differs from requested dedicated policy')
    suffix = hashlib.sha256(name.encode()).hexdigest()[:8]
    install('iptables', 'filter', 'KSF' + suffix, policy_rules(core, subnet, BRIDGE, wan), 'FORWARD')
    install('iptables', 'filter', 'KSI' + suffix, [['-i', BRIDGE, '-j', 'DROP']], 'INPUT')
    for parent in ('INPUT', 'FORWARD'):
        rules = [['-i', BRIDGE, '-j', 'DROP']]
        if parent == 'FORWARD':
            rules.append(['-o', BRIDGE, '-j', 'DROP'])
        install('ip6tables', 'filter', 'KS6' + suffix + parent[0], rules, parent)
    # Override primary daemon's raw direct-route rejection only for permitted ingress.
    for rule in (['-s', core, '-d', subnet, '-p', 'tcp', '--dport', '6080', '-j', 'ACCEPT'], ['-d', subnet, '-m', 'conntrack', '--ctstate', 'RELATED,ESTABLISHED', '-j', 'ACCEPT']):
        if subprocess.run(['iptables', '-w', '-t', 'raw', '-C', 'PREROUTING', *rule], capture_output=True).returncode:
            subprocess.check_call(['iptables', '-w', '-t', 'raw', '-I', 'PREROUTING', '1', *rule])
    nat = ['-s', subnet, '-o', wan, '-j', 'MASQUERADE']
    if subprocess.run(['iptables', '-w', '-t', 'nat', '-C', 'POSTROUTING', *nat], capture_output=True).returncode:
        subprocess.check_call(['iptables', '-w', '-t', 'nat', '-A', 'POSTROUTING', *nat])
    run('sysctl', '-q', '-w', 'net.ipv4.ip_forward=1')
    data = {'version': 1, 'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'networkId': info['Id'], 'subnet': subnet, 'coreIp': core}
    fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    with os.fdopen(fd, 'w') as handle:
        json.dump(data, handle)

if __name__ == '__main__':
    main()
