#!/usr/bin/env python3
"""The cockpit's own identity, and its answer to the Stump's /auth challenge.

A Stump set to hybrid or closed (mandatory) only lets a verified identity
write (closed: read too). FireFly and Stump apps verify with /auth: the Stump
answers "AUTH-CHALLENGE <nonce hex>", the app signs the nonce's hex text with
its Reticulum identity and sends "/auth <public key hex> <signature hex>".
The handheld's cockpit does the same, with an identity of its own (not the
Stump's): made the first time, kept in a file for its owner only, next to
the cockpit, and kept across updates.

Run with the Stump's own Python, so it signs with the Stump's own Reticulum
code (urns):
    cockpit_auth.py --stump ~/Stump --key ~/stump_r36max/cockpit_identity sign   (nonce hex on stdin)
        -> "<public key hex> <signature hex>"
    cockpit_auth.py --stump ~/Stump --key FILE hash
        -> its identity's hash (what the Stump verifies it as)
The private key is never printed.
"""

import os
import re
import sys


def load(stump, key):
    stump = os.path.abspath(os.path.expanduser(stump))
    sys.path[:0] = [os.path.join(stump, "pc_compat"), stump]      # as stump_pc.py runs the firmware
    from urns.identity import Identity
    key = os.path.expanduser(key)
    if os.path.isfile(key):
        ident = Identity.from_file(key)
        if ident is None:
            raise SystemExit("the cockpit's identity file won't read: %s" % key)
        return ident
    ident = Identity()
    fd = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(fd, ident.get_private_key())
    finally:
        os.close(fd)
    return ident


def main(argv):
    args = dict(zip(argv[:-1:2], argv[1:-1:2]))
    cmd = argv[-1] if argv else ""
    if "--stump" not in args or "--key" not in args or cmd not in ("sign", "hash"):
        raise SystemExit(__doc__)
    out, sys.stdout = sys.stdout, sys.stderr        # the Stump's own notes: not the answer
    ident = load(args["--stump"], args["--key"])
    if cmd == "hash":
        out.write(ident.hexhash + "\n")
        return
    nonce = sys.stdin.readline().strip()
    if not re.fullmatch(r"[0-9a-f]{16,128}", nonce):
        raise SystemExit("not a challenge: %r" % nonce[:40])
    # The Stump checks a signature over the nonce's hex TEXT (stumpid's
    # complete_challenge), not its bytes.
    out.write("%s %s\n" % (ident.get_public_key().hex(), ident.sign(nonce.encode()).hex()))


if __name__ == "__main__":
    main(sys.argv[1:])
