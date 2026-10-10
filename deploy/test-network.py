#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location('policy', Path(__file__).with_name('remapped-network.py'))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)

class Rules(unittest.TestCase):
    def test_private_and_metadata_denied_before_public(self):
        rules = policy.policy_rules('172.18.0.2', '172.30.0.0/24', 'ksabc', 'ens5')
        public = rules.index(['-i', 'ksabc', '-o', 'ens5', '-s', '172.30.0.0/24', '-j', 'ACCEPT'])
        for subnet in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10'):
            self.assertLess(rules.index(['-i', 'ksabc', '-d', subnet, '-j', 'DROP']), public)
    def test_core_replies_only_established_desktop(self):
        rule = policy.policy_rules('172.18.0.2', '172.30.0.0/24', 'ksabc', 'ens5')[1]
        self.assertIn('ESTABLISHED', rule)
        self.assertIn('--sport', rule)
        self.assertIn('6080', rule)
    def test_other_inbound_and_bridge_traffic_denied(self):
        rules = policy.policy_rules('172.18.0.2', '172.30.0.0/24', 'ksabc', 'ens5')
        self.assertIn(['-i', 'ksabc', '-j', 'DROP'], rules)
        self.assertEqual(rules[-1], ['-o', 'ksabc', '-j', 'DROP'])


# Isolated command-state fixture, never invokes host firewall tools.
from unittest.mock import patch
from types import SimpleNamespace

class FakeFirewall:
    def __init__(self):
        self.chains = {}
        self.fail_append = False
    def execute(self, argv, **kwargs):
        tool, _, _, table, action, chain, *rest = argv
        key = (tool, table, chain)
        rules = self.chains.setdefault(key, [])
        code, text = 0, ''
        if action == '-N': pass
        elif action == '-C': code = 0 if rest in rules else 1
        elif action == '-I':
            position = int(rest.pop(0)) - 1
            rules.insert(position, rest)
        elif action == '-D': rules.remove(rest)
        elif action == '-F': rules.clear()
        elif action == '-A':
            if self.fail_append:
                raise RuntimeError('fixture install failure')
            rules.append(rest)
        elif action == '-S': text = '\n'.join('-A ' + chain + ' ' + ' '.join(r) for r in rules)
        else: raise AssertionError(argv)
        return SimpleNamespace(returncode=code, stdout=text)
    def output(self, argv, **kwargs):
        return self.execute(argv, **kwargs).stdout
    def call(self, argv, **kwargs):
        assert self.execute(argv, **kwargs).returncode == 0

class RestartFixture(unittest.TestCase):
    def test_restart_both_families_idempotence_failure_and_retry(self):
        fake = FakeFirewall()
        policy.BRIDGE = 'ksfixture'
        with patch.object(policy.subprocess, 'run', fake.execute), patch.object(policy.subprocess, 'check_call', fake.call), patch.object(policy.subprocess, 'check_output', fake.output):
            for restart in range(2):
                if restart: fake.chains.clear()  # simulated host rules lost, no actual restart
                policy.startup_guards(policy.BRIDGE)
                snapshot = {k:[list(r) for r in v] for k,v in fake.chains.items()}
                policy.startup_guards(policy.BRIDGE)
                self.assertEqual(snapshot, fake.chains)
                for tool in ('iptables','ip6tables'):
                    for parent in ('INPUT','FORWARD'):
                        rules = fake.chains[(tool,'filter',parent)]
                        self.assertTrue(any('-i' in r for r in rules))
                        if parent == 'FORWARD': self.assertTrue(any('-o' in r for r in rules))
                fake.fail_append = True
                with self.assertRaises(RuntimeError):
                    policy.install('iptables','filter','KSFixture',[['-i',policy.BRIDGE,'-j','DROP']],'FORWARD')
                self.assertTrue(any('kamakura-startup-ksfixture' in r for r in fake.chains[('iptables','filter','FORWARD')]))
                fake.fail_append = False
                for repeat in range(2):
                    for tool in ('iptables','ip6tables'):
                        for parent in ('INPUT','FORWARD'):
                            chain = 'KSFixture' + parent[0]
                            policy.install(tool,'filter',chain,[['-i',policy.BRIDGE,'-j','DROP']],parent)
                            rules = fake.chains[(tool,'filter',parent)]
                            jump = rules.index(['-j',chain])
                            self.assertTrue(all(i < jump for i,r in enumerate(rules) if 'kamakura-startup-ksfixture' in r))
                policy.startup_guards(policy.BRIDGE, remove=True)
                for tool in ('iptables','ip6tables'):
                    for parent in ('INPUT','FORWARD'):
                        self.assertEqual(fake.chains[(tool,'filter',parent)],[['-j','KSFixture'+parent[0]]])
    def test_source_hook_precedes_daemon_and_core_restore(self):
        root = Path(__file__).parent
        source = (root/'resume-local-test.sh').read_text()
        self.assertLess(source.index('remapped-network.sh --guard-only'),source.index('dockerd >/tmp'))
        self.assertLess(source.index('remapped-network.sh --guard-only'),source.index('docker compose up'))
        source = (root/'start-remapped-daemon.sh').read_text()
        self.assertLess(source.index('remapped-network.sh" --guard-only'),source.index('exec dockerd'))
        self.assertLess(source.index('remapped-network.sh" --guard-only'),source.index('if docker'))
        source = (root/'remapped-network.py').read_text()
        self.assertLess(source.index('json.dump(data, handle)'),source.index('startup_guards(BRIDGE, remove=True)'))

if __name__ == '__main__':
    unittest.main()
