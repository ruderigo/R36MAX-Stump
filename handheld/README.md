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
| `cockpit_feed.py` | The cockpit's client of the Stump (`/rrc/poll`, `/rrc/send`, `/post`, `/upload`, `/chain.json`…) and of NetworkManager for the hotspot |
| `stump_r36max_engine.c` | The cockpit (v1.8.8's, minus everything that went around the Stump) |
| `stump_pygame_display.py` | The KMSDRM presenter from v1.8.8, unchanged |
| `sync_app.py` | Regenerates `src/engine/stumpNativeCode.ts` so the web app shows these exact files |
| `test_cockpit_feed.py` | Tests for the feed |

## Install (or update)

From the Mac, with the handheld on your Wi-Fi and online:

```sh
ssh -t ark@r36max.local 'if [ -d ~/R36MAX-Stump/.git ]; then git -C ~/R36MAX-Stump pull --ff-only; else git clone https://github.com/ruderigo/R36MAX-Stump.git ~/R36MAX-Stump; fi && bash ~/R36MAX-Stump/handheld/install.sh'
```

(Before this branch is merged, add `-b r36max-pc-stump` after `git clone`.)

`install.sh` asks for the sudo password once. Then **SandBox_Stump_On's own
Provisioner asks its usual questions**. Answer them as you did for macOS1:

- folder: `~/Stump` (the default);
- chain: *Joins another Stump's Wi-Fi* → *On the Wi-Fi it's on now* → LaBuche3's
  address → the chain's secret;
- Heltec: *on USB* if it's plugged in;
- start at login: **yes**.

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
- **Hotspot** (NETWORK/SETUP panels): an open Wi-Fi named `PC_HOTSPOT_NAME`
  (from `config.py`) at `10.42.0.1`, which is the Linux hotspot in `docs/PC.md`.
  With two Wi-Fi adapters (internal + RT3070) it goes on the free one, so the
  handheld stays on your network. The Stump restarts to pick up the address.
- **Sharing files:** put them in `/roms/ports/stump_r36max/drop/` (on the TF
  card), then FILES → share. Each file goes through the Stump's own `/upload`.
  Files the old v1.x node had shared were copied there for you.
- **Deleting** notices or files uses the Stump's `/admin` delete with the admin
  password from `~/Stump/config.py`, which never leaves the handheld.
- **TF backups and diagnostics** go to `/roms/ports/stump_r36max/tf_backup/`.
- Logs: `~/Stump/stump.log` (the Stump), `/roms/ports/stump_r36max/cockpit.log` (the cockpit).
- Stop and start the Stump: `~/Stump/stop-stump.sh` / `~/Stump/start-stump.sh`, or
  `systemctl --user stop|start stump`.

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
