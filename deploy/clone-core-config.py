"""Prepare a replacement core Config, without inheriting Docker-generated identity.

No Docker operations. Caller retains ownership of admission gates and policy repair.
Custom hostnames/domainnames are deliberately unsupported by this clone path:
the sandbox admission check resolves the current core via its Docker hostname.
"""
from copy import deepcopy


def clone_core_config(config):
    cloned = deepcopy(config)
    cloned.pop("Hostname", None)
    cloned.pop("Domainname", None)
    return cloned
