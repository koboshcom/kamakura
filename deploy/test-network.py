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

if __name__ == '__main__':
    unittest.main()
