#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('guard', Path(__file__).with_name('egress-guard.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

class PolicyTests(unittest.TestCase):
    def test_both_families_private_special_and_transition_denied(self):
        policy = guard.rules('172.19.0.2,2001:4860::1', '8.8.8.8')
        for address in guard.V4_DENY + guard.V6_DENY + ['172.19.0.2/32','2001:4860::1/128','8.8.8.8/32']:
            self.assertIn(address, policy)
        self.assertIn('ip6 daddr 2000::/3 accept', policy)
        self.assertIn('chain forward { type filter hook forward priority -150; policy drop;', policy)
        self.assertEqual(policy.count('priority -150; policy drop;'), 3)
    def test_dns_before_nat_and_private_drop_before_public_allow(self):
        policy = guard.rules('172.19.0.2', '')
        self.assertLess(policy.index('ip daddr 127.0.0.11 meta'), policy.index('ip daddr 127.0.0.11 reject'))
        self.assertLess(policy.index('ip daddr 127.0.0.11 reject'), policy.index('oifname "lo" accept'))
        self.assertLess(policy.index('ip daddr @denied4 counter reject'), policy.index('meta nfproto ipv4 accept'))
        self.assertLess(policy.index('ip6 daddr @denied6 counter reject'), policy.index('ip6 daddr 2000::/3 accept'))
        self.assertIn('ct direction reply ct original proto-dst 6080', policy)
    def test_nft_injection_rejected(self):
        with self.assertRaises(ValueError):
            guard.rules('1.2.3.4; accept', '')
        with self.assertRaises(ValueError):
            guard.rules('', 'host.docker.internal')
    def test_snapshot_preserves_policy_not_transient_handles(self):
        self.assertEqual(guard.canonical({'handle':1,'policy':'drop','expr':[{'accept':None}]}), {'policy':'drop','expr':[{'accept':None}]})
        self.assertNotEqual(guard.canonical({'policy':'drop'}), guard.canonical({'policy':'accept'}))

if __name__ == '__main__':
    unittest.main()
