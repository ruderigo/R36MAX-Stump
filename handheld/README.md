# R36MAX Stump: a Stump like any other, with a 720×720 cockpit

The R36MAX runs **the stock Stump on a computer** from
[SandBox_Stump_On](https://github.com/ruderigo/SandBox_Stump_On):
`pc/stump_pc.py`, set up by `provisioner.py --pc`, the same way macOS1 or any
Linux laptop runs it. The firmware is the same and is **not modified**; the
wizard, `/admin`, the chain, the Heltec on USB and the way it updates are all
the same. One difference (v2.5.0): it runs **only while its Port is open**,
like a ROM, with no start-at-login; the launcher starts it and stops it.

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
                                                                                   (started and stopped by the launcher)
```

| File | What it is |
|---|---|
| `install.sh` | Installs or updates everything, on the handheld |
| `LaBuche_Stump.sh` | The Ports launcher: opens the cockpit; SELECT+START returns to EmulationStation |
| `limbs.py` | The Wi-Fi cards and their jobs (EmulationStation's network, an AP, idle), for the feed |
| `cockpit_feed.py` | The cockpit's client of the Stump (`/rrc/poll`, `/rrc/send`, `/post`, `/upload`, `/chain.json`…) and of NetworkManager for the hotspot |
| `cockpit_auth.py` | The cockpit's own identity and its answer to `/auth` (hybrid and closed Stumps), with the Stump's own Reticulum code |
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
- start at login: **no** (the Port starts and stops it; `install.sh --answers`
  forces this).

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
  stops the Stump and goes back to EmulationStation. Nothing of it runs in the
  background: the handheld is a Stump while the cockpit is open (so it never
  runs beside FireFly, which since Stump 1.0.0-beta.55 would fight it for the
  Wi-Fi local-discovery port).
- Its pages: `http://r36max.local/` (or the address in the cockpit's header).
  `/admin` works as on every Stump: radio, chain, plugins, turning it off.
- **Rooms** (CHATS tab): every room the Stump has, not just the three
  built-in ones, with how many people are in each; ←/→ moves between them,
  and the line under them says how far the room reaches (this Stump, the
  chain's Wi-Fi, the LoRa) and its topic. *new room…* in the quick commands
  makes one on this Stump (`/join`) and opens it.
- **The sticks** (v2.7.0) scroll the chat (up: older, down: newer, through
  the 60 lines the Stump keeps per room) and move through the lists on the
  other tabs, as the D-pad does.
- **All commands…** (chat deck, v2.7.0): every command this Stump answers,
  in groups, its packs' included. ↑/↓ moves, ←/→ jumps a group, A uses it
  (sent at once, or the keyboard opens with it half-written). `•` stands for
  the admin password: the cockpit fills it in before sending.
- **Sound** (v2.7.3, v2.7.4): button chimes and a message chime, on USB-C
  headphones when plugged in; both can be turned off on OWNER. See
  [Sound](#sound).
- **Hybrid or closed Stumps** (v2.7.2): the cockpit verifies itself with
  `/auth`, as FireFly does, with an identity of its own
  (`~/stump_r36max/cockpit_identity`, made the first time; keep it, it's who
  the cockpit is), so it reads and writes whatever the Stump's mode.
  A command's answer appears in the room (for you only).
- **The admin password** is read from `~/Stump/config.py`
  (`AUTH_ADMIN_PASSWORD`, or `FSERVBOT_OP_PASSWORD` when that's blank), so
  a Stump installed without the provisioner has its owner tools too. None
  yet: OWNER → *Set the admin password* (type your own) or *Make one for
  me*; OWNER → *Change the admin password* types a new one (v2.7.1). To use
  it from a phone: OWNER → *Show the admin password* (30 seconds).
- **OWNER tab** (v2.6.0): the Stump's owner on their own handheld, with the
  admin password from `~/Stump/config.py` (it never leaves the handheld):
  - *Stump settings*: the same form as `/admin`'s, read from the Stump's own
    page in its language and saved the same way (name, bot, greeting,
    language, announces and stamps, file sharing, storage, who may enter,
    features). The Stump answers as on the web: saved, or waits for a
    restart, or which value it didn't accept.
  - *Rooms*: each room's reach (`/setchan`), a new room reaching the chain
    or the LoRa (`/create`), the topic, the LoRa rooms other Stumps offer
    (`/chanreq`: accept or refuse).
  - *People in the room*: op, mod, kick, mute, ban and back, in that room or
    every room of the Stump; who's op or mod, who's banned or muted.
  - *Announce now*, *Restart the Stump*.
  ↑/↓ moves, ←/→ picks, A applies (what changes the Stump asks first), B
  goes back. The rest of `/admin` (radio, chain, plugins, themes, layout,
  profiles) from a phone on its hotspot.
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
  itself when the card is plugged in again while the cockpit is open. Any card that supports
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
- By hand, outside the cockpit (over SSH): `~/Stump/start-stump.sh` / `~/Stump/stop-stump.sh`.

## Sound

Everything the cockpit plays, and when. (The Stump itself plays nothing:
the stock computer Stump has no sound.)

**Where it plays.** On a USB sound device when one is plugged in (USB-C
headphones, a headset, a DAC), otherwise the handheld's built-in speaker,
as Ember does. It's chosen again for every chime, so plugging or
unplugging needs nothing else; a device unplugged in the middle of a chime
is reopened for the next. `STUMP_OUT=plughw:0,0` (any ALSA device) in
`LaBuche_Stump.sh`'s environment fixes it. Volume is the handheld's own.

**What it plays.** Short square-wave tones, made by the engine (no sound
files):

| Sound | Tone | When |
|---|---|---|
| **Message chime** | two notes going up, E6 then A6 (1319, 1760 Hz), 0.18 s | A message arrives that OWNER → *Message chime* wants: by default a private message (DM) to the cockpit; with *everything*, any line from someone else in the room on screen |
| Move | one tick, 500–540 Hz, 10–25 ms | Moving through a list, the keyboard, a form, the command menu, rooms, or scrolling the chat |
| The end | low tick, 300 Hz, 20 ms | Scrolling past the oldest line there is |
| Choose | 580 Hz, 25 ms | A choice changes: a Wi-Fi card's job, a notice or file ticked |
| Open | 620–740 Hz, 35–45 ms | Opening the command menu, a form, the NETWORK tab, the keyboard for a secret; a card remembered (740) or not (520) |
| Ask first | 660 Hz, 40–50 ms | A yes/no question opens before something that changes the Stump or a card; a quick-deck command sent; the QR code switched |
| Send, apply | 840 Hz, 55–65 ms | Sending a message or a command, applying a setting, the chain's settings saved |
| Done | 880 Hz, 65–85 ms | A Wi-Fi card's job confirmed, a NETWORK action carried out |
| Back, hint | 420–480 Hz, 25–35 ms | Back out of a form or the menu, cancel, delete a character; or a hint on what to do first ("←/→ to pick, then A"), or the menu asked for before the Stump sent its commands |
| Can't | 340 Hz, 40 ms | Something that can't be done here (a card that can't run an access point) |

**Turning them off.** On the OWNER tab (no admin password needed):

- *Button chimes*: on (default) or off. Every sound in the table but the
  message chime.
- *Message chime*: DMs (default), everything, or off. Picking DMs or
  everything plays it once so you can hear it.

Both are kept in `~/stump_r36max/cockpit_settings.json` for the next start.

**Never.** No chime for your own lines, for the scrollback that arrives
when you join a room, for the DMs that were waiting when the cockpit
started, or for joins and leaves. Several messages at once give one chime.

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
