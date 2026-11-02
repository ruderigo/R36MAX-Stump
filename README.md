# R36MAX Stump

<img width="300" height="400" alt="r36MAX_Stump" src="https://github.com/user-attachments/assets/75b1b8cb-2e83-4600-9b95-d44c42bc2c31" />


Turns an **R36MAX handheld** (RK3326, dArkOS) into a **Stump**: a node of
the Stump/FireFly LoRa mesh, like LaBuche3 or macOS1. It has its own web
pages, chat, notice board and file shelf, and its own place in the chain.
You use it from the handheld's 720×720 screen and buttons, or from any phone
or laptop on its Wi-Fi.

The Stump itself is the stock one from
[SandBox_Stump_On](https://github.com/ruderigo/SandBox_Stump_On), unmodified,
running in the background from boot. This repo adds what only the handheld
needs: the on-screen **cockpit**, its launcher in EmulationStation, and an
installer that sets it all up.

| | |
|---|---|
| **Latest release** | [v2.0.0-r36max](https://github.com/ruderigo/R36MAX-Stump/releases/latest) |
| **Handheld details** | [handheld/README.md](handheld/README.md): how it works, controls, tests, releases |
| **Changes** | [handheld/CHANGELOG.md](handheld/CHANGELOG.md) |

---

## Install guide

About 10 to 20 minutes, most of it downloading packages. You need:

- an **R36MAX on dArkOS**, charged or plugged in;
- **Wi-Fi with internet** (only for the install);
- a **computer on the same Wi-Fi** with a terminal (Terminal on a Mac);
- if it will join a chain: the **address of the Stump it joins** (e.g. LaBuche3)
  and the **chain's secret**;
- optional: a **Heltec** LoRa board on USB, a USB keyboard on the OTG port.

### 1. Get the handheld ready

1. On the handheld, **connect to your Wi-Fi** (dArkOS's Options menu → Wi-Fi).
2. **Turn on SSH**: in Options, *Enable Remote Services*.
3. On the computer, check that you can reach it:

   ```sh
   ssh ark@r36max.local
   ```

   The password is dArkOS's (`ark` unless you changed it). Type `exit` to
   leave. If `r36max.local` isn't found, use the handheld's IP address
   instead (dArkOS shows it in Options, or look in your router's device list),
   here and in every command below.

### 2. Install

Pick **one** of the two ways. Both run the same installer.

**A. From git (recommended: updating is one command).** From the computer:

```sh
ssh -t ark@r36max.local 'command -v git >/dev/null || sudo apt-get install -y git; if [ -d ~/R36MAX-Stump/.git ]; then git -C ~/R36MAX-Stump pull --ff-only; else git clone https://github.com/ruderigo/R36MAX-Stump.git ~/R36MAX-Stump; fi && bash ~/R36MAX-Stump/handheld/install.sh'
```

**B. From the release file.** Fixed at one version, with a checksum. On the
handheld, over `ssh ark@r36max.local`:

```sh
V=2.0.0-r36max
curl -LO https://github.com/ruderigo/R36MAX-Stump/releases/download/v$V/R36MAX-Stump-handheld-$V.tar.gz
curl -LO https://github.com/ruderigo/R36MAX-Stump/releases/download/v$V/SHA256SUMS
sha256sum -c SHA256SUMS && tar xzf R36MAX-Stump-handheld-$V.tar.gz
bash R36MAX-Stump-$V/handheld/install.sh
```

### 3. Answer the installer

- It asks for the **sudo password** once (the same `ark` password).
- It installs packages, downloads SandBox_Stump_On and puts any old v1.x
  cockpit aside (moved, never deleted).
- Then **SandBox_Stump_On's own setup wizard** asks its usual questions,
  the same as on every computer Stump:

  | Question | Answer |
  |---|---|
  | Folder | `~/Stump` (the default: just press Enter) |
  | Chain | *Joins another Stump's Wi-Fi* → *On the Wi-Fi it's on now* → the parent Stump's address (e.g. LaBuche3's) → the chain's secret. No chain: say so, it can be set later. |
  | Heltec | *On USB* if one is plugged in, otherwise none |
  | Start at login | **Yes** |

- It ends with a **Check** line. `Stump up: <name> 1.0.0-beta.NN on :80, chain …`
  means it worked.

### 4. Open it

On the handheld: **EmulationStation → Ports → LaBuche_Stump**. If it isn't
listed yet, restart EmulationStation (or the handheld).

- **SELECT + START** goes back to EmulationStation. The Stump keeps running
  in the background, and it starts by itself at every boot.
- Its web pages: `http://r36max.local/` from any device on the same Wi-Fi
  (or the address in the cockpit's header). `/admin` works as on every Stump.
- **Wi-Fi:** choose the network, and type its password, in dArkOS's own Wi-Fi
  settings (as in step 1). The Stump uses whatever network the handheld is on
  and follows a change by itself; the cockpit just shows which one.

### Controls

| Where | Button | Does |
|---|---|---|
| Everywhere | L / R | change tab: chats, board, files, network, setup |
| Everywhere | D-pad, A, B | move, choose, back |
| Chats tab | Y | open the keyboard to write |
| Everywhere | SELECT + START | back to EmulationStation |
| On-screen keyboard | A / B / X / Y | type / delete / space / shift (upper case) |
| On-screen keyboard | L / R | letters ↔ symbols ↔ accents |
| On-screen keyboard | START / SELECT | send or OK / cancel |

A **USB keyboard** on the OTG port (or a hub on it) works everywhere you type:
on the chat tab, just start typing. Enter sends, Esc cancels.

### Update

- Installed **from git** (A): run the same command again. It pulls this repo
  and SandBox_Stump_On and re-runs the wizard, which keeps your settings,
  identity and everything saved.
- Installed **from a release** (B): do B again with the new version number.

### If something's wrong

| You see | Look at / do |
|---|---|
| The cockpit's screen stays black | `/roms/ports/stump_r36max/cockpit.log` |
| The Stump doesn't answer | `~/Stump/stump.log`; `sudo systemctl status stump-ark` |
| Pages only on `:8080`, no sign-in pop-up on the hotspot | the installer printed `setcap failed`: run it again |
| Other Stumps show as `mesh-xxxx` for minutes after a restart | every Stump needs SandBox_Stump_On **1.0.0-beta.43** or newer (LaBuche3 too) |
| The chain doesn't link | `cd ~/SandBox_Stump_On && python3 provisioner.py --check-chain` |
| Change the chain, secret or parent | `/admin`, or `python3 ~/SandBox_Stump_On/provisioner.py --pc --reconfigure` |

Stop or start the Stump by hand: `~/Stump/stop-stump.sh`, `~/Stump/start-stump.sh`.

### Uninstall

```sh
sudo systemctl disable --now stump-ark       # or: systemctl --user disable --now stump
rm -rf ~/stump_r36max
sudo rm -f /roms/ports/LaBuche_Stump.sh /roms2/ports/LaBuche_Stump.sh \
           /etc/sudoers.d/stump-r36max /etc/NetworkManager/dnsmasq-shared.d/stump.conf
```

`~/Stump` holds the Stump's identity, settings and saved posts and files. Keep
it if you might reinstall (the Stump comes back as itself); delete it to
start over. `/roms/ports/stump_r36max/` holds the TF backups and `drop/`.

---

## The web app

The rest of the repo is a browser app (React + Vite): a preview of the
cockpit and the Stump's pages, the handheld's source files, and the AV
breakbeat workstation and file chewer. It doesn't need the handheld.

```sh
npm install --legacy-peer-deps
npm run dev          # http://localhost:3000
```

The AI features need a Gemini API key in `.env.local` (see `.env.example`).

## For developers

```sh
bash handheld/tests/run_tests.sh [path/to/SandBox_Stump_On]   # the handheld's tests
npm run lint && npm run build                                  # the web app
```

GitHub runs both on every push. A tag `v<version>` (matching
`handheld/VERSION`) publishes a release; see
[handheld/README.md](handheld/README.md#tests-and-releases).

The cockpit uses DejaVu Sans Mono ([its licence](handheld/FONT_LICENSE)).
