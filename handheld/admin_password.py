#!/usr/bin/env python3
"""The handheld Stump's passwords: /admin's (AUTH_ADMIN_PASSWORD) and the fserv
bot operator's (FSERVBOT_OP_PASSWORD: editing its dialogue from the chat), in
its config.py.

Team Stump's design is one password: /admin takes AUTH_ADMIN_PASSWORD when
it's set, else the fserv operator's (stumpid/core.py check_admin_password),
which the computer wizard asks. But the wizard leaves AUTH_ADMIN_PASSWORD as
SandBox_Stump_On's final_firmware/config.py has it unless "Change any of
those now?" is answered yes, and that file isn't blank: the one password
then never reaches /admin. This says whether it's still the repo's, clears
it (/admin falls back to the fserv operator's) or sets either, with the
Stump's own settings.write_config (what /admin uses), config.py.bak kept.

    admin_password.py --stump ~/Stump --template ~/SandBox_Stump_On/final_firmware/config.py state
        -> SET (its own), DEFAULT (still the repo's), EMPTY, NONE (no Stump there)
    admin_password.py --stump ~/Stump set              (the password on stdin, one line)
    admin_password.py --stump ~/Stump --key FSERVBOT_OP_PASSWORD set|state
                                                       (the fserv operator's instead)
    admin_password.py --stump ~/Stump one              (the one password on stdin: the fserv operator's,
                                                        and /admin's by clearing AUTH_ADMIN_PASSWORD)
    admin_password.py --stump ~/Stump clear            (AUTH_ADMIN_PASSWORD blank: /admin takes the fserv one)
    admin_password.py --stump ~/Stump --answers FILE   ("_admin password" in the answers file, if there)
        -> SET, NOTHING (none in it), SHORT (under 4 characters: not set)

The password is never printed, logged or put on a command line.
"""

import ast
import json
import os
import shutil
import sys

MIN = 4


def value_in(path, key="AUTH_ADMIN_PASSWORD"):
    """The literal value assigned to key in a config.py, or None."""
    try:
        with open(path, encoding="utf-8") as f:
            tree = ast.parse(f.read())
    except (OSError, SyntaxError, ValueError):
        return None
    found = None
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == key for t in node.targets):
            try:
                found = ast.literal_eval(node.value)
            except ValueError:
                found = None
    return found


KEYS = ("AUTH_ADMIN_PASSWORD", "FSERVBOT_OP_PASSWORD")


def state(stump, template=None, key="AUTH_ADMIN_PASSWORD"):
    cfg = os.path.join(stump, "config.py")
    if not os.path.isfile(cfg):
        return "NONE"
    v = value_in(cfg, key)
    if not v:
        return "EMPTY"
    if template and v == value_in(template, key):
        return "DEFAULT"
    return "SET"


def write(stump, pw, key="AUTH_ADMIN_PASSWORD"):
    """Sets it with the Stump's own settings.write_config; config.py.bak kept."""
    if key not in KEYS:
        raise SystemExit("not a password this sets: %s" % key)
    if len(pw) < MIN:
        return "SHORT"
    return write_values(stump, {key: pw})


def write_values(stump, values):
    cfg = os.path.join(stump, "config.py")
    shutil.copy2(cfg, cfg + ".bak")
    sys.path.insert(0, stump)
    import settings                          # the Stump's own (what /admin uses)
    if not settings.write_config(values, cfg):
        raise SystemExit("config.py wasn't written")
    try:
        with open(cfg, encoding="utf-8") as f:
            compile(f.read(), "config.py", "exec")
    except SyntaxError:
        shutil.copy2(cfg + ".bak", cfg)
        raise SystemExit("the new config.py wasn't Python: put back as it was")
    return "SET"


def main(argv):
    args = dict(zip(argv[0::2], argv[1::2])) if len(argv) % 2 == 0 else dict(zip(argv[:-1:2], argv[1:-1:2]))
    stump = os.path.expanduser(args.get("--stump", "~/Stump"))
    key = args.get("--key", "AUTH_ADMIN_PASSWORD")
    cmd = argv[-1] if len(argv) % 2 else ""
    if "--answers" in args:
        try:
            with open(args["--answers"], encoding="utf-8") as f:
                pw = json.load(f).get("_admin password") or ""
        except (OSError, ValueError):
            pw = ""
        print(write(stump, pw) if pw else "NOTHING")
    elif cmd == "one":
        pw = sys.stdin.readline().rstrip("\n")
        print("SHORT" if len(pw) < MIN else write_values(stump, {"FSERVBOT_OP_PASSWORD": pw, "AUTH_ADMIN_PASSWORD": ""}))
    elif cmd == "clear":
        print(write_values(stump, {"AUTH_ADMIN_PASSWORD": ""}))
    elif cmd == "set":
        pw = sys.stdin.readline().rstrip("\n")
        print(write(stump, pw, key))
    elif cmd == "state":
        print(state(stump, args.get("--template"), key))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
