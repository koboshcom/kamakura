#!/usr/bin/env python3
"""Render paired transcripts, keeping the condition key separate from the reviewer input."""
import argparse
import json
import secrets
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('before')
p.add_argument('after')
p.add_argument('output')
p.add_argument('key')
a = p.parse_args()
def read(path):
    rows = {}
    for line in Path(path).read_text().splitlines():
        if line.startswith('PAIRED_CASE '):
            row = json.loads(line.split(' ', 1)[1])
            if row['id'] in rows:
                raise ValueError('Duplicate case ' + row['id'])
            rows[row['id']] = row
    return rows
b, c = read(a.before), read(a.after)
if set(b) != set(c) or len(b) != 7:
    raise ValueError('Require all seven matching complete conversations')
render, key = [], {}
ids = list(b)
secrets.SystemRandom().shuffle(ids)
for i, case in enumerate(ids, 1):
    swap = secrets.randbelow(2)
    pair = [('before', b[case]), ('after', c[case])]
    if swap:
        pair.reverse()
    render.append(f'Conversation {i}')
    key[str(i)] = {'case': case, 'A': pair[0][0], 'B': pair[1][0]}
    for label, (_, row) in zip(('A', 'B'), pair):
        render.append(f'Condition {label}')
        for turn in row['turns']:
            render.append('User ' + turn['user'])
            render.append('Cat ' + (turn['reply'] or '[no message]'))
        render.append('')
Path(a.output).write_text('\n'.join(render))
Path(a.key).write_text(json.dumps(key, indent=2) + '\n')
print('Rendered seven blind conversation pairs')
