# R36MAX Stump: changes

Each release is a git tag `v<VERSION>` (the version is in `handheld/VERSION`).
Pushing the tag runs the tests and publishes a GitHub release with
`R36MAX-Stump-handheld-<VERSION>.tar.gz`, its `SHA256SUMS`, and the section
below as its notes.

## v2.1.0-r36max

**The Wi-Fi is EmulationStation's.** The network and its password are
chosen in dArkOS's own Wi-Fi settings; the Stump uses whatever network the
handheld is on, and follows a change by itself.

- The cockpit shows the network the handheld is on (name, signal, address).
  It no longer scans, joins networks or takes a Wi-Fi password.
- The hotspot only goes on a Wi-Fi adapter that network isn't using (the
  RT3070 next to the internal one). With one adapter in use it says so and
  leaves the network alone: it used to replace it.
- Tests: the feed never joins or changes a network, never sends a password,
  and keeps the hotspot off EmulationStation's adapter.

## v2.0.0-r36max

**The R36MAX runs the stock PC Stump.** It is now a Stump like macOS1 or any
Linux laptop: SandBox_Stump_On's `pc/stump_pc.py`, set up by
`provisioner.py --pc`, unmodified. The handheld's screen and buttons are a
client of it.

- **The bridge is gone.** `run_stump_r36max.py` (161 KB) moved the node's web
  server behind its own proxy, ran its own DHCP/DNS and chain discovery, and
  patched the firmware at run time. The stock Stump does all of that itself.
- **The cockpit talks to the Stump like a browser does**, through its public
  HTTP API (`/rrc/poll`, `/rrc/send`, `/post`, `/upload`, `/admin` deletes,
  `/chain.json`). It no longer writes the Stump's files, and no longer accepts
  chat lines from anyone on the LAN over UDP :42420.
- **Starts from boot**, serves on port 80 and answers captive DNS on 53 (one
  capability on the Stump's own Python, not the system's), and opens the
  hotspot through NetworkManager.
- **FireFly's look**: Team FireFly's amber palette, its DejaVu Sans Mono font,
  its header, chat bubbles and hint bar.
- **FireFly's keyboard, with real upper and lower case**, for chat, Wi-Fi
  passwords and the chain secret: A types, B deletes, X space, Y shift, L/R
  change page (letters, symbols, accents), START sends or OKs, SELECT cancels.
- **A USB keyboard** works on the OTG port or a hub: Shift, Caps Lock, the
  usual symbols; on the chat tab, just start typing.
- **Fixed:** the black screen on dArkOS (the cockpit draws through the system
  SDL2 on KMSDRM); `visudo` and `usermod` missing from dArkOS's sudo path; the
  old `echo 0 | sudo -S tee …`, which gave the data to sudo as its password.
- **No longer done on every launch:** flushing the firewall, masking
  NetworkManager, killing the Stump.
- **Needs SandBox_Stump_On 1.0.0-beta.43 or newer on every Stump** for other
  Stumps to show up by name within seconds of a restart (`install.sh` warns
  when it's older). Tested against 1.0.0-beta.46.
- **Tests and releases:** `handheld/tests/run_tests.sh` (versions, scripts,
  feed, font, engine, keyboard, the web app's copy) and
  `handheld/tests/test_with_stump.py` (every cockpit command against a real
  Stump) run on every push; a `v…` tag packages and publishes the release.
