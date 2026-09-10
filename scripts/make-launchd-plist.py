#!/usr/bin/env python3
"""Write a headless Mac mini worker configuration; never install or start it."""
import argparse
from pathlib import Path
import plistlib


def absolute(value):
    path = Path(value)
    if not path.is_absolute():
        raise argparse.ArgumentTypeError('must be an absolute path on the target Mac')
    return str(path)


def make_plist(project, node, python, user):
    root = Path(project)
    return {
        'Label': 'com.haokaiding.tianshu-replica',
        'UserName': user,
        'ProgramArguments': [node, str(root / 'bin/tianshu-worker.mjs'), '--root', project, 'once'],
        'WorkingDirectory': project,
        'EnvironmentVariables': {
            'PI_CODING_AGENT_DIR': str(root / '.pi-company'),
            'TIANSHU_PYTHON': python,
            'PATH': ':'.join(dict.fromkeys([str(Path(node).parent), str(Path(python).parent), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])),
        },
        'StartInterval': 60,
        'RunAtLoad': True,
        'KeepAlive': False,
        'ProcessType': 'Background',
        'LowPriorityIO': True,
        'StandardOutPath': str(root / '.queue/worker.stdout.log'),
        'StandardErrorPath': str(root / '.queue/worker.stderr.log'),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', required=True, type=absolute)
    parser.add_argument('--node', required=True, type=absolute)
    parser.add_argument('--python', required=True, type=absolute)
    parser.add_argument('--user', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    result = make_plist(args.project, args.node, args.python, args.user)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('xb') as stream:
        plistlib.dump(result, stream, sort_keys=False)
    print(args.output.resolve())


if __name__ == '__main__':
    main()
