import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("clone", Path(__file__).with_name("clone-core-config.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CloneTests(unittest.TestCase):
    def test_identity_not_inherited_and_config_preserved(self):
        original = {"Hostname": "old-id", "Domainname": "old-domain", "Env": ["X=y"],
                    "Labels": {"owner": "beta"}, "Image": "unchanged", "Cmd": ["node", "dist/index.js"]}
        result = module.clone_core_config(original)
        self.assertNotIn("Hostname", result)
        self.assertNotIn("Domainname", result)
        self.assertEqual(result, {k: v for k, v in original.items() if k not in ("Hostname", "Domainname")})
        result["Labels"]["owner"] = "changed"
        self.assertEqual(original["Labels"]["owner"], "beta")
        self.assertEqual(original["Hostname"], "old-id")

    def test_missing_identity_is_valid(self):
        self.assertEqual(module.clone_core_config({"Env": []}), {"Env": []})


if __name__ == "__main__":
    unittest.main()
