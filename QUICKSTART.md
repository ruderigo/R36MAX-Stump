# R36MAX Stump quick start

Turns an R36MAX handheld into a Stump: a node of the Stump/FireFly mesh
with its own chat, notice board and file shelf, run from the handheld's
screen and buttons (the cockpit), or from any phone on its Wi-Fi. This page
gets you going; the [README](README.md#install-guide) has every step,
[handheld/README.md](handheld/README.md) how it all works.

## What you need

- An R36MAX (RK3326) running dArkOS, on Wi-Fi with internet for the
  install, reachable as `r36max.local` (or by its address).
- Optional: a Heltec LoRa board on USB; USB-C headphones for the sound.

## Install (or update)

1. From your computer, run:
   ```sh
   ssh -t ark@r36max.local 'command -v git >/dev/null || sudo apt-get install -y git; if [ -d ~/R36MAX-Stump/.git ]; then git -C ~/R36MAX-Stump pull --ff-only; else git clone https://github.com/ruderigo/R36MAX-Stump.git ~/R36MAX-Stump; fi && bash ~/R36MAX-Stump/handheld/install.sh'
   ```
2. It asks for the `ark` sudo password once, then the Stump's own questions:
   folder `~/Stump` (Enter), the chain (or none), the Heltec (or none),
   start at login **No**.
3. It ends with `Stump up: <name> …`. Running the same command again
   updates it and keeps your settings and identity.

## Open it

**EmulationStation → Ports → LaBuche_Stump.** SELECT + START stops the
Stump and goes back. Nothing runs in the background: the handheld is a
Stump while the cockpit is open.

## The tabs (L / R)

| Tab | What's there |
|---|---|
| CHATS | The Stump's rooms (←/→), the quick deck (↑/↓, A), the keyboard (Y) |
| BOARD | Its notices |
| FILES | Its file shelf |
| NETWORK | The handheld's Wi-Fi cards and their jobs |
| SETUP | The Stump's log and its chain |
| OWNER | Owner tools: rooms, people, settings, the admin password, and this handheld's sound |

## The buttons

| Button | What it does |
|---|---|
| D-pad | Move; on CHATS, ←/→ the rooms and ↑/↓ the quick deck |
| Either stick | Scroll the chat (up: older), move through any list |
| A / B | Choose / back |
| Y (CHATS) | Write |
| *all commands…* (CHATS deck) | Every command the Stump answers, its packs' too; `•` is the admin password, filled in for you |
| SELECT + START | Back to EmulationStation |

A USB keyboard works wherever you type.

## Sound

| Sound | When | Change it |
|---|---|---|
| Message chime: two notes going up | A private message (DM) to you | OWNER → *Message chime*: DMs, everything (every line from someone else), off |
| Button chimes: short ticks | As you press buttons | OWNER → *Button chimes*: on, off |

- **Where:** USB-C headphones when plugged in, otherwise the speaker.
- **Never:** for your own lines, the scrollback when you join a room, joins
  and leaves. Several messages at once give one chime.
- **Volume:** the handheld's volume buttons. The Stump itself plays nothing.
- Every chime and what it means: [handheld/README.md → Sound](handheld/README.md#sound).

## The admin password

The cockpit fills it in for you. None yet: OWNER → *Set the admin password*
(type your own) or *Make one for me*. For `/admin` on a phone: OWNER →
*Show the admin password* (30 seconds).

## If something's wrong

- The screen stays black: `/roms/ports/stump_r36max/cockpit.log`.
- More: [README → If something's wrong](README.md#if-somethings-wrong).
