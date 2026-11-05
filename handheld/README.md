# R36MAX Stump: a Stump like any other, with a 720×720 cockpit

The R36MAX runs **the stock Stump on a computer** from
[SandBox_Stump_On](https://github.com/ruderigo/SandBox_Stump_On):
`pc/stump_pc.py`, set up by `provisioner.py --pc`, the same way macOS1 or any
Linux laptop runs it. The firmware is the same and is **not modified**; the
wizard, the start-at-login service, `/admin`, the chain, the Heltec on USB and
the way it updates are all the same.

The only R36MAX-specific parts are the handheld's own screen and controls,
which sit **outside** the Stump and talk to it the way any app does:

```
 EmulationStation ─ Ports ─ LaBuche_Stump.sh
                              │
   stump_pygame_display.py ── stump_r36max_engine (C, 720×720, gamepad)
                              │  /dev/shm/stump_live.txt  ▲   UDP :42421 commands
                              ▼                           │
                        cockpit_feed.py  ── HTTP (public API, like a browser) ──►  the Stump
                                                                                   ~/Stump/stump_pc.py
                                                                                   (systemd --user "stump", from boot)
```

| File | What it is |
|---|---|
| `install.sh` | Installs or updates everything, on the handheld |
| `LaBuche_Stump.sh` | The Ports launcher: opens the cockpit; SELECT+START returns to EmulationStation |
| `limbs.py` | The Wi-Fi cards and their jobs (EmulationStation's network, an AP, idle), for the feed |
| `cockpit_feed.py` | The cockpit's client of the Stump (`/rrc/poll`, `/rrc/send`, `/post`, `/upload`, `/chain.json`…) and of NetworkManager for the hotspot |
| `stump_r36max_engine.c` | The cockpit (v1.8.8's, minus everything that went around the Stump) |
| `stump_pygame_display.py` | The KMSDRM presenter from v1.8.8, unchanged |
| `cockpit_font.bin`, `gen_font.py`, `FONT_LICENSE` | FireFly's font (DejaVu Sans Mono), pre-rendered for the engine |
| `VERSION`, `CHANGELOG.md` | The one version number, and what changed in each |
| `tests/run_tests.sh` | All the tests that need no handheld (run on every push by `.github/workflows/handheld.yml`) |
| `tests/test_with_stump.py` | Every cockpit command, against a real stock Stump |
| `tests/test_keyboard.c` | The keyboard driven with the R36MAX's real button codes |
| `test_cockpit_feed.py` | Unit tests for the feed |
| `test_limbs.py` | The Wi-Fi cards, with the R36MAX's own `iw` output, a fake `/sys` and NetworkManager |
| `package.sh` | The release tarball, its checksums and notes |
| `sync_app.py` | Regenerates `src/engine/stumpNativeCode.ts` so the web app shows these exact files |

## Tests and releases

```sh
bash handheld/tests/run_tests.sh                       # versions, scripts, feed, font, engine, keyboard, app copy
bash handheld/tests/run_tests.sh ../SandBox_Stump_On   # ... plus the feed against a real Stump
```

GitHub runs them on every push and pull request, with the web app's checks.
To release, set `handheld/VERSION`, add its `## v…` section to
`CHANGELOG.md` (the tests fail until every file agrees), merge, then:

```sh
git tag v2.4.0-r36max && git push origin v2.4.0-r36max
```

The tag runs every test, then publishes a GitHub release with
`R36MAX-Stump-handheld-<version>.tar.gz` and `SHA256SUMS`. On the handheld:
`tar xzf` it and run `bash R36MAX-Stump-<version>/handheld/install.sh`.

## Install (or update)

From the Mac, with the handheld on your Wi-Fi and online:

```sh
ssh -t ark@r36max.local 'if [ -d ~/R36MAX-Stump/.git ]; then git -C ~/R36MAX-Stump pull --ff-only; else git clone https://github.com/ruderigo/R36MAX-Stump.git ~/R36MAX-Stump; fi && bash ~/R36MAX-Stump/handheld/install.sh'
```

The step-by-step guide (getting the handheld ready, the release-file
install, update, troubleshooting, uninstall) is in the
[repo's README](../README.md#install-guide).

`install.sh` asks for the sudo password once. Then **SandBox_Stump_On's own
Provisioner asks its usual questions**. Answer them as you did for macOS1:

- folder: `~/Stump` (the default);
- chain: *Joins another Stump's Wi-Fi* → *On the Wi-Fi it's on now* → LaBuche3's
  address → the chain's secret;
- Heltec: *on USB* if it's plugged in;
- start at login: **yes**.

**From the gamepad instead** (v2.3.0): the RK3326 Provisioner's *This
handheld's Stump* asks the same things in a form on the screen and runs
`install.sh --answers FILE.json`, which hands them to the wizard
(`provisioner.py --pc --answers`); nothing is typed over SSH. The first
install still needs internet.

Run the same command again to update. It pulls both repos and re-runs
`provisioner.py --pc`, which keeps `config.py`, the identity and everything
that's been saved.

## Using it

- **EmulationStation → Ports → LaBuche_Stump** opens the cockpit. **SELECT+START**
  goes back to EmulationStation. The Stump **keeps running** in the background,
  as it does on a computer.
- Its pages: `http://r36max.local/` (or the address in the cockpit's header).
  `/admin` works as on every Stump: radio, chain, plugins, turning it off.
- **Chain secret, role, parent:** in `/admin` or with
  `python3 ~/SandBox_Stump_On/provisioner.py --pc --reconfigure`, as on every
  Stump. The cockpit shows the chain's state but doesn't edit it.
- **Wi-Fi: EmulationStation's.** Choose the network and type its password in
  dArkOS's own Wi-Fi settings, as for anything else on the handheld. The
  Stump uses whatever network the handheld is on and follows a change by
  itself (new address, announced to the other Stumps, chain parent found
  again). The cockpit shows that network; it doesn't join or change networks.
- **Wi-Fi cards and their jobs** (NETWORK tab): every Wi-Fi card on the
  handheld, plugged in in any order, is listed with its job:
  *Local LAN (ES)* (EmulationStation's network, shown), *AP 2.4 GHz* /
  *AP 5 GHz* (the Stump's open Wi-Fi with its sign-in page), or *Idle*.
  ←/→ chooses a job, A applies it (it asks first, and says when the handheld
  would leave its network), Y remembers it: a remembered AP comes back by
  itself when the card is plugged in again, or at boot. Any card that supports
  AP mode can be an AP, the Blueway included, and as many as there are cards:
  the first at `10.42.0.1` (`PC_HOTSPOT_NAME`), the next at `10.42.1.1`
  (`…-2`) and so on, each on its own channel. The Stump restarts when the APs
  change, to answer the sign-in page on the right address.
- **Sharing files:** put them in `/roms/ports/stump_r36max/drop/` (on the TF
  card), then FILES → share. Each file goes through the Stump's own `/upload`.
  Files the old v1.x node had shared were copied there for you.
- **Deleting** notices or files uses the Stump's `/admin` delete with the admin
  password from `~/Stump/config.py`, which never leaves the handheld.
- **TF backups and diagnostics** go to `/roms/ports/stump_r36max/tf_backup/`.
- **After a restart** the R36MAX names and lists the other Stumps within about 10 s, when every
  Stump runs SandBox_Stump_On 1.0.0-beta.43 or newer (PR #11, asked by Team R36MAX). With older
  Stumps it shows them as `mesh-xxxx` for up to 2 minutes and lists them only at their
  half-hourly beacon: the chain works, it just looks broken. The CAM (LaBuche3) needs it too.
- Logs: `~/Stump/stump.log` (the Stump), `/roms/ports/stump_r36max/cockpit.log` (the cockpit).
- Stop and start the Stump: `~/Stump/stop-stump.sh` / `~/Stump/start-stump.sh`, or
  `systemctl --user stop|start stump`.

## The look and the keyboard (FireFly's)

The cockpit follows Team FireFly's RK3326 app: its amber palette, its font
(DejaVu Sans Mono, at FireFly's sizes for a 720 px screen), its header with
tab pills and a link dot, its keycap hint bar, its chat bubbles, and its
keyboard, key for key:

| Button | On the keyboard |
|---|---|
| D-pad | move |
| A | type the key |
| B | delete one character |
| X | space |
| Y (or ⇧ on screen) | shift: the next letter in upper case |
| L / R | page: `abc`, symbols, accents (à é ç ñ ß ✓ → …) |
| START | send (chat) or OK (chain secret) |
| SELECT | cancel |

Upper and lower case are real: what you type is sent exactly. (Wi-Fi
passwords are typed in EmulationStation's Wi-Fi settings, not here.)

**A USB keyboard** works too, on the OTG port or on a hub plugged into it:
Shift, Caps Lock and the usual symbols (`{ } | \ ~` included). On the chat tab
just start typing: the keyboard view opens with what you type. Enter sends,
Esc cancels, Backspace deletes.

The font is pre-rendered (`gen_font.py` makes `cockpit_font.bin` from
`fonts-dejavu-core`; DejaVu's licence is in `FONT_LICENSE`), so the handheld
needs no font library. Without the file the cockpit falls back to its old
capitals-only font.

## Two things a laptop doesn't need

Both are outside the Stump and done by `install.sh`:

1. **Ports 80 and 53.** A Linux Stump that isn't root serves on `:8080` and
   skips its captive DNS. The installer makes the Stump's venv Python a real
   file (`venv --copies`) and gives that one binary `cap_net_bind_service`.
   So the Stump serves on `:80` and phones on the hotspot get the sign-in
   pop-up, as on a CAM, while the system `python3` stays unprivileged.
2. **The hotspot's DNS** goes to the Stump's captive DNS:
   `/etc/NetworkManager/dnsmasq-shared.d/stump.conf` (`port=0` plus a DHCP
   DNS option). NetworkManager still does DHCP.

It also allows `nmcli`, `chmod`, `tee` and `iw` through `sudo` without a
password (`/etc/sudoers.d/stump-r36max`), for the launcher and the hotspot.

## v2.0.0-r36max — The R36MAX runs the stock PC Stump

- **The bridge is gone.** `run_stump_r36max.py` (161 KB) moved the node's web
  server to :8880 behind its own proxy, ran its own DHCP/DNS and chain
  discovery, patched `admin_web`, made `socket.sendto` swallow errors, and
  re-imported `example_node` in a loop. Most v1.8.x fixes (self-ghost, peer
  names, chain socket rebinds, path requests) were repairs to those hooks. The
  stock PC Stump does all of it itself.
- **The cockpit is a client of the Stump.** It reads and acts through the
  Stump's public HTTP API; it no longer reads or writes `sd/billboard.txt` or
  `sd/shared/`. It also no longer posts any LAN datagram on UDP :42420 into
  #wifi-mesh, which anyone on the network could do.
- **Kept from v1.8.8:** the KMSDRM display path (no `FBIOBLANK`, no
  `KD_TEXT`, cursor hidden), the five panels, the QR code (now the Stump's real
  address and port).
- **Fixed:** v1.8.8's `echo 0 | sudo -S tee …` sent the data to sudo as the
  password, so the cursor-hide failed whenever sudo needed one.
- **No longer done:** `nft flush ruleset` / `iptables -P INPUT ACCEPT` on every
  launch, masking/unmasking NetworkManager, killing the Stump on every launch.

## How it was tested (and what wasn't)

In a Linux container, against **real, unmodified SandBox_Stump_On 1.0.0-beta.42**:

- a folder made by the Provisioner's own functions, run with `stump_pc.py --service`
  as an unprivileged `ark` user with the venv capability: it served on `:80`,
  its captive DNS answered on `:53`, and the system python was still refused;
- a two-Stump chain in separate network namespaces (a root, and this Stump as a
  member on the same LAN): linked, secret verified. #wifi-mesh worked both ways:
  the root saw `r36max@R36Test`, and the cockpit saw `rod@RootTest`;
- the feed driving every cockpit command against it: chat in #main and
  #wifi-mesh, notice post and admin delete, upload from `drop/`, file delete,
  TF backups and diagnostics;
- the patched engine built with `-Wall -Wextra` and no warnings; its
  `--smoke` test passed; its framebuffer was captured with live data from the Stump;
- `test_cockpit_feed.py`; the web app's `tsc` check, build and existing tests.

**Not tested on the R36MAX itself.** That covers dArkOS's systemd user manager
(`loginctl enable-linger`), NetworkManager hotspot mode on the RT3070, file
capabilities on the 4.4 kernel, and the KMSDRM presenter with this engine.
`install.sh` says plainly when any of these fails, and the Stump still runs
on `:8080` without the capability.
