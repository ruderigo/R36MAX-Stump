# R36MAX Stump: changes

Each release is a git tag `v<VERSION>` (the version is in `handheld/VERSION`).
Pushing the tag runs the tests and publishes a GitHub release with
`R36MAX-Stump-handheld-<VERSION>.tar.gz`, its `SHA256SUMS`, and the section
below as its notes.

## v2.3.0-r36max

**Installed and updated from the RK3326 Provisioner, with the gamepad.**

- `install.sh --answers FILE.json`: the same install or update, with no one
  at the keyboard. The file answers SandBox_Stump_On's own wizard
  (`provisioner.py --pc --answers`, 1.0.0-beta.48 or newer); nothing is read
  from the keyboard, sudo must not ask for a password (dArkOS's `ark`
  doesn't), and whatever would ask stops the install with its reason. The
  RK3326 Provisioner's *This handheld's Stump* writes the file from a form on
  the screen and runs this.
- Without `--answers`, nothing changes: the wizard asks over SSH as before.
- The first install still needs internet (packages, SandBox_Stump_On, the
  Stump's Python packages); the messages say so when it's missing.
- Tests: the options (`--answers`, a missing file, an unknown option).

## v2.2.0-r36max

**Every Wi-Fi card is a limb with a job** (SandBox_RK3326_Stump, docs/PLAN.md).
The cockpit lists every Wi-Fi card on the handheld, plugged in in any order,
and gives each one a job: EmulationStation's network (shown, chosen there),
the Stump's AP, or nothing.

- **An AP on any card that supports AP mode**, the one EmulationStation uses
  included (it asks first, and says the handheld leaves that network; turning
  the AP off gives the network back). The card is asked, not a list, so a
  future card qualifies by itself.
- **As many APs as cards**, each on its own range (10.42.0.1, 10.42.1.1…),
  channel (1, 6, 11) and name (`-2`, `-3`…), 5 GHz where the card has it.
  Every AP hands out its own address for DNS, so each gets the sign-in page.
- **Remember** (Y on a card): a remembered AP comes back by itself when the
  card is plugged in again, or at boot, cockpit open or not
  (NetworkManager's autoconnect, kept per card by its hardware address).
- **Plugged in?** The cockpit says so and offers the card a job.
- The NETWORK tab has one row per card (←/→ the job, A apply, Y remember);
  SETUP shows the result. The old "stage, then apply in SETUP" is gone.
- v2.0's single hotspot connection (`Stump-Hotspot`) is replaced by the
  card's own the first time an AP is set.
- Tests: `test_limbs.py`, with the R36MAX's own `iw` output, a fake `/sys`
  and a NetworkManager that keeps state (take-over and back, N APs, ranges,
  5 GHz, remember, hotplug in any order); every character the cockpit draws
  is checked against its font.

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
