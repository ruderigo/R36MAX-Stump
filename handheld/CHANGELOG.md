# R36MAX Stump: changes

Each release is a git tag `v<VERSION>` (the version is in `handheld/VERSION`).
From 2.5.0 the version ends in `-b.NN`: the SandBox_Stump_On build
(1.0.0-beta.NN) it was tested against, as FireFly shows its build.
Pushing the tag runs the tests and publishes a GitHub release with
`R36MAX-Stump-handheld-<VERSION>.tar.gz`, its `SHA256SUMS`, and the section
below as its notes.

## v2.7.2-b.87

- **The cockpit verifies itself, as FireFly does.** On a Stump set to
  *hybrid* or *closed* (`/admin mode`), only a verified identity may write
  (closed: read too), and the cockpit wasn't one: it was put back in #main
  and everything it sent was refused. `/auth` only gave it a challenge it
  never answered. Now the cockpit answers it with an identity of its own
  (`cockpit_identity`, next to the cockpit, made the first time, for its
  owner only, kept across updates), signed with the Stump's own Reticulum
  code (`cockpit_auth.py`). It verifies as it connects, again if the Stump
  restarts and forgets (checked every minute), and before resending a line
  the Stump refused for that. `/auth` from the menu does it now and says
  who it's verified as.
- **A command's answer is shown.** What the Stump answers a `/command` sent
  from the cockpit (`/whoami`, `/names`, `/rooms`, a refusal...) went only
  to the log: it now appears in the room, as lines for you only, and on the
  status line.
- Tests: the Stump's "verify first" answers recognised; a command's answer
  in the room; with a real Stump: verified at start (`/whoami`), closed
  from the menu, the cockpit still reads and writes there while an
  unverified visitor can't, then open again.

## v2.7.1-b.87

- **Type the admin password on the handheld.** OWNER → *Set the admin
  password* when the Stump has none (with *Make one for me* beside it), and
  *Change the admin password* when it has one: the keyboard opens, START
  saves it. It's written with the Stump's own `admin_password.py`
  (`config.py.bak` kept) as `AUTH_ADMIN_PASSWORD`, and the Stump restarts to
  take it. 4 characters or more, no spaces (the chat's owner commands take
  it as one word), no `•` and no `|`; anything else is refused with why and
  the old password kept. It's never logged or shown on the row.
- **Deleting from the billboard and the files works again** on a Stump with
  only the file bot operator's password (installed without the
  provisioner): those two still read `AUTH_ADMIN_PASSWORD` alone, missed in
  v2.7.0. Op, deop and the other moderation already took either.
- Tests: set, then changed, through `admin_password.py`; the passwords it
  won't take leave the old one; deletes with the operator's password. The
  real-Stump test now runs as such a Stump (`/admin`'s password blank, the
  operator's set): settings, rooms, deletes, op and the menu's `•` all pass
  through it.

## v2.7.0-b.87

- **The sticks scroll.** The chat had no way back to what was said before:
  now either stick scrolls it (up: older, down: newer), through everything
  the Stump keeps for the room (60 lines). "↑ older" and "↓ N newer" show
  there is more; new messages keep a scrolled view where it is; sending
  brings it back to the newest. On the other tabs the sticks do what the
  D-pad does (the billboard, the files, NETWORK, the log, OWNER's forms, the
  keyboard, the menu). A first step at once, then repeats while held.
- **Lists show everything.** The billboard drew 4 of its notices and the files
  5, and the cursor went on to ones not on screen: both now scroll with the
  cursor, with "↑/↓ more" marks, and keep 20 each.
- **All commands…** on the chat deck (where *say hello* was): every command this
  Stump answers, in groups — chat, moderation, owner, the file bot's `!`
  words, and each pack's own commands under its name — read from `/help`,
  `/help mods`, `/setchan`, `/chanreq`, `/fshelp`, `/fslist`, the command
  reference and `/plugins.json` (so commands `/help` leaves out are there
  too). ↑/↓ moves, ←/→ jumps a group, A uses it: one with nothing to add is
  sent at once, the others open the keyboard with the command written up to
  its first argument.
- **Owner commands without typing the password.** Where a command takes the
  admin password, the menu writes `•`; the cockpit fills in the Stump's own
  password from `~/Stump/config.py` before sending (the cockpit's screen
  never has it). It takes the admin password, or the file bot operator's
  when that one is blank, as the Stump itself does: a Stump installed
  without the provisioner now gets its owner tools.
- **No admin password yet?** OWNER → *Make one now*: a random one is written
  with the Stump's own `admin_password.py` (its `config.py.bak` kept) and the
  Stump restarts with it. OWNER → *Show the admin password* shows it for 30
  seconds, for the Stump's `/admin` page from a phone.
- Tests: the command catalog from the Stump's real replies, `•` filled in,
  the password fallback and *Make one now*; the menu, scrolling and the
  sticks in the C test; with a real Stump: its commands listed (never the
  password) and a `/setchan •` from the menu carried out.

## v2.6.1-b.87

- **Whole messages in the chat.** A line was cut after 44 characters and drawn
  on 2 lines at most, sent or received, in every room: the feed passed the
  cockpit only the start of it. Now the whole line comes through, up to the
  Stump's own limit (400 characters), and its bubble wraps it at spaces on
  as many lines as it takes (10 at most, which 400 characters fit).
- Tests: a 400-character line reaches the cockpit whole (the feed's unit
  test and the C test of the live file).

## v2.6.0-b.87

Tested against SandBox_Stump_On **1.0.0-beta.87** (the feed with a real
Stump: every command, the new ones included; the cockpit's keys and screens).

- **Every room the Stump has** on the CHATS tab, not just #main, #lora-mesh
  and #wifi-mesh: the rooms people made, with how many are in each, as the
  Stump's own chat page lists them. ←/→ moves between them (as many as fit,
  the rest scroll), and under them: how far the room reaches (this Stump,
  the chain's Wi-Fi, the LoRa) and its topic.
- **A new room** from the quick commands (*new room…*, where *announce* was:
  the Stump announces by itself): its name on the keyboard, made with
  `/join` on this Stump, and on screen. START with nothing written opens the
  keyboard.
- **OWNER, a sixth tab: the Stump's owner on their own handheld.** It uses
  the admin password in `~/Stump/config.py`, which stays on the handheld:
  - **Stump settings**: the very form `/admin` shows, read from the Stump's
    page (its labels, in its language) and sent back as a browser would. So
    it's always what this Stump offers: name, bot and greeting, language,
    announces and Reticulum 1.6.1's announce stamps, file sharing, storage,
    who may enter, features. The Stump's answer is shown: saved, waits for
    a restart, or which value it refused.
  - **Rooms**: each room's reach (`/setchan`), a room reaching the chain or
    the LoRa (`/create`), the topic, and the LoRa rooms other Stumps offer
    (`/chanreq`, accept or refuse).
  - **People in the room**: op, deop, mod, demod, kick, mute, unmute, ban,
    unban, in the room or every room of the Stump; who's op or mod, who's
    banned or muted. The Stump's replies show under the list.
  - **Announce now** and **Restart the Stump**.
  ←/→ picks, A applies, and what changes the Stump asks first (No is
  highlighted). The rest of `/admin` (radio, chain, plugins, themes) stays on
  the web, from a phone on the hotspot.
- The tab names are a size smaller, so six fit beside the link dot.
- Tests: the feed against a real Stump now makes rooms, changes a setting
  through `/admin/setup` (the others untouched), makes a Wi-Fi room, changes
  a room's reach, and kicks someone; the feed's unit tests read and submit a
  form as a browser does; the C tests drive the rooms and the OWNER tab with
  the R36MAX's buttons.

## v2.5.4-b.86

Tested against SandBox_Stump_On **1.0.0-beta.86** (the cockpit's feed with a
real b86 Stump: all pass; the RK3326 Provisioner's answers through b86's own
wizard: all pass).

- **Its announce stamps** (beta.86, Reticulum 1.6.1's proof of work on
  announces). With *Announce stamps* ticked in its /admin, the handheld's
  Stump finds them by itself in the background; the end of an install now
  also names Team Stump's tool to do it at once, every core on it:
  `provisioner.py --stamp-announces ~/Stump`. The RK3326 Provisioner
  (0.3.0-beta.20) does it from its screen.
- Nothing else needed changing for b83 to b86: the cockpit reads the Stump
  over its HTTP API, which stamps (on announces over the mesh) don't touch.

## v2.5.3-b.82

Tested against SandBox_Stump_On **1.0.0-beta.82** (the cockpit's feed with a
real b82 Stump: all pass; the RK3326 Provisioner's answers through b82's own
wizard: all pass).

- **Its packs and its identity, from Team Stump's own tools.** The end of an
  install says how, when its SandBox_Stump_On has them: `provisioner.py
  --packs ~/Stump` (beta.75: install, update, remove, nothing else asked)
  and `--save-identity ~/Stump` (beta.76: the file that brings back the same
  Stump on the mesh after a fresh install, with `--restore-identity`). The
  RK3326 Provisioner (0.3.0-beta.19) does both from its screen.
- Nothing else needed changing for b63 to b82: the cockpit reads the Stump
  over its HTTP API, which packed text (b82, LXMF over LoRa) doesn't touch.

## v2.5.2-b.62

Tested against SandBox_Stump_On **1.0.0-beta.62** (the cockpit's feed with a
real b62 Stump: all pass).

- **Installed from the RK3326 Provisioner, sudo's password typed on its
  screen.** With `--answers` (how the Provisioner runs it) install.sh
  needed sudo with no password at all, and stopped otherwise. Given sudo's
  askpass helper (the Provisioner 0.3.0-beta.16 passes one), every sudo in
  it goes through the helper (`sudo -A`), so a 10-20 minute first install
  outliving sudo's ticket still gets the password; a wrong one stops it
  before anything changes. Never piped into `sudo -S`. Over SSH nothing
  changes.

## v2.5.1-b.60

Tested against SandBox_Stump_On **1.0.0-beta.60**: the cockpit's feed with a
real b60 Stump (every command, the live file, the TF card: all pass), and the
answers the RK3326 Provisioner sends (0.3.0-beta.14) through b60's own wizard.

- **b58's setup questions.** The wizard asks the admin password (/admin;
  required) and gives the fserv bot the same one; its template has no
  passwords of its own any more. `install.sh --answers` takes the
  Provisioner's answers as they are (it sends b58's keys beside the old
  ones), and the password step finds both set: nothing to clear. Over SSH,
  the hints say the admin password is asked and required. The repo's
  password handling stays for Stumps before b58.
- The install's check says *parent … not heard yet* right after the start
  (it said "heard Nones ago"), and no longer prints the beta.43 reminder
  about the other Stumps every time (the warning about this one stays).
- Tests: `test_admin_password.py` with b58+'s template (no repo password:
  the older case kept with the template as it was), and as the wizard now
  writes both.

## v2.5.0-b.55

(`-b.55`: tested against SandBox_Stump_On 1.0.0-beta.55. v2.5.0-r36max was
tagged first by mistake and is the same code; this tag replaces it.)

**Nothing in the background: the Stump runs while its Port is open**, like a
ROM. Opening *Ports → LaBuche_Stump* starts the stock Stump and the cockpit;
SELECT+START stops both (the radio off first, through `/admin/poweroff` as
`stop-stump.sh` does) and goes back to EmulationStation. Checked against
SandBox_Stump_On **1.0.0-beta.55**.

- Why now: since 1.0.0-beta.55 a computer Stump speaks Reticulum's
  AutoInterface (Wi-Fi local discovery), the same one FireFly uses. On one
  handheld both can't: they want the same port on the same link-local
  address, and the first one up keeps it. With one Port at a time in
  EmulationStation, they never run together.
- `install.sh`: no start-at-login, no boot service, no `loginctl
  enable-linger`. An earlier install's `stump-ark` system service and
  `systemd --user` service are disabled and removed, and a running copy
  stopped. With `--answers`, *start this stump automatically when you log
  in* is forced to no. The final check starts the Stump, reads `/node.json`
  and `/chain.json`, then stops it. The sudoers file no longer allows
  `systemctl` (nothing to restart).
- `LaBuche_Stump.sh`: stops any copy left from before (v2.4's start-at-login
  too), starts the Stump for the session, and stops it on exit.
- What changes for the user: no web pages, AP, chain link or LoRa relay once
  the cockpit is closed; a remembered AP comes back when the cockpit is open.
  Over SSH, `~/Stump/start-stump.sh` / `stop-stump.sh` still work by hand.
- SandBox_Stump_On's beta.49-55 need nothing else here: the handheld's Stump
  gets the address page with both QR codes, NomadNet browsing and hubs, the
  NomadNet and Simple packs (say yes to them in the wizard, or
  `install nomadnet` / `install simple` in the answers file) and opt-in LXMF
  stamps for free. The suite, including the live test against a stock
  beta.55 Stump, passes unchanged.

## v2.4.0-r36max

**Its password reaches /admin.** Team Stump's design is one password:
/admin takes the fserv operator password (which the computer wizard asks)
unless `AUTH_ADMIN_PASSWORD` is set. But the wizard leaves
`AUTH_ADMIN_PASSWORD` as SandBox_Stump_On's `final_firmware/config.py` has
it unless "Change any of those now?" is answered yes, and that file isn't
blank: the password asked never reached /admin (found on the bench).

- After the wizard, `install.sh` clears the repo's `AUTH_ADMIN_PASSWORD`
  when the fserv operator password is set, so /admin takes that one, with
  the Stump's own `settings.write_config` (what /admin uses;
  `config.py.bak` kept). Over SSH, with no password of its own yet, it asks
  one (hidden, twice) for both.
- A separate /admin password, if wanted, comes from the answers file's
  `_admin password`.
- It says which password /admin takes, and warns while either is still the
  repo's.
- `admin_password.py`: the state of either password, `one` (the fserv
  operator's, and /admin's through it), `clear`, `set`; never printed or
  put on a command line.
- Tests: `test_admin_password.py` (with SandBox_Stump_On's real
  `settings.py` and `config.py` when given).

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
