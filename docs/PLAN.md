# Plan: network limbs (Wi-Fi cards with a job)

Sandbox for the RK3326 (R36MAX) Stump. Work is iterated here, then released
in [R36MAX-Stump](https://github.com/ruderigo/R36MAX-Stump), as Team Stump
does with SandBox_Stump_On and Team FireFly with SandBox_FireFly_RK3326.

Status: **in progress**. The cockpit-side build is under way; the on-device
checks are listed under [Bench](#bench).

## What we want

1. **No second Wi-Fi picker.** EmulationStation (dArkOS's Wi-Fi settings)
   chooses the network and holds its password. The Stump uses whatever the
   handheld is on and follows a change by itself (it re-reads its addresses,
   announces again, finds its chain parent again). The cockpit only shows it.
2. **Every Wi-Fi card is a limb with a job**, hotplugged on the hub in any
   order. The cockpit lists them all and gives each one a job:
   - **Local LAN (ES)**: the card EmulationStation connected. Shown, not chosen.
   - **AP**: the Stump's open Wi-Fi with its sign-in page. Offered on **any
     card that says it supports AP mode**, now and in the future, the card ES
     uses included ("take over": the handheld leaves that network while the
     AP is on, and gets it back when the AP is turned off).
   - **Idle**: plugged in, unused.
3. **As many APs as there are cards** (N+1 on a hub).
4. **Remember** (a toggle per card): a remembered AP comes back by itself when
   the card is plugged in again, or at boot, cockpit open or not. Not
   remembered: the cockpit offers the job again when the card appears.

## What the handheld has today

From `lsusb; iw dev; iw list` on the R36MAX (2026-11-02):

- **One Wi-Fi card: the Blueway High Power, Ralink RT3070 (`148f:3070`,
  driver `rt2800usb`)**, on a Genesys hub (`05e3:0610`). It is `wlan0`,
  connected (EmulationStation's network), 2.4 GHz.
- Its modes include **`AP`**. So "take over the current card" is the main
  case today, not an edge case.
- There is no internal Wi-Fi: with the Blueway as the AP, the handheld has
  no other network. A chain over the home Wi-Fi (e.g. to LaBuche3) pauses
  while the AP is on; the cockpit warns before taking the card over.

## Design

### A card is known by its hardware, not its name

`wlan0`/`wlan1` change with the plug order. A card is keyed by its
**permanent MAC** (`/sys/class/ieee80211/<phy>/macaddress`), and described by
its USB id and driver. Friendly names come from a small table
(`148f:3070` → *Blueway High Power*); any other card shows as its chipset or
USB id. **AP support and bands are read from the card itself** (`iw phy`:
"Supported interface modes" has `AP`; "Band 1" is 2.4 GHz, "Band 2" 5 GHz),
so a future card qualifies without a code change.

### One NetworkManager connection per AP card

`Stump-AP-<mac>`: Wi-Fi in AP mode, **bound to the card's MAC** (not to
`wlanN`), open, `ipv4.method shared` (DHCP from NetworkManager, as the
single hotspot already did), IPv6 off.

| | |
|---|---|
| Address | 10.42.**slot**.1/24. Slot 0 is `10.42.0.1`, the address the stock Stump already knows as "the Linux hotspot" |
| Channel | by slot: 1, 6, 11 on 2.4 GHz; 36, 44, 149… on 5 GHz |
| Name | slot 0: `PC_HOTSPOT_NAME` (config.py); slot 1+: the same plus `-2`, `-3`… *(open decision below)* |
| Remember | `connection.autoconnect` yes/no, with a priority above ES's networks, so NetworkManager itself brings it back on replug or at boot |

Turning an AP off brings the connection down; NetworkManager then reconnects
EmulationStation's network on that card by itself.

### The sign-in page on every AP

The DHCP of every AP hands out **its own address** as DNS (dnsmasq
`dhcp-option=option:dns-server,0.0.0.0`, in `install.sh`), where the Stump's
captive DNS listens (it binds `0.0.0.0:53`). That DNS answers every name
with one address, the Stump's hotspot address, chosen when it starts:
`10.42.0.1` when slot 0 is up. Phones on `10.42.1.x` reach it through the
handheld (it owns both). So **the Stump restarts once after the set of APs
changes**, as it did after the single hotspot. *(Team Stump, later: answer
with the address the question arrived on; not needed to start.)*

### Hotplug

The feed lists the cards every few seconds. A card that wasn't there:

- remembered as an AP → NetworkManager has already brought it up; the
  cockpit says so;
- AP-capable, not remembered → a notice: *New Wi-Fi: <name>, AP-capable —
  NETWORK: give it a job*;
- no AP mode → listed as such.

A card unplugged takes its AP with it (the Stump restarts to drop it).

### The cockpit

NETWORK tab: one row per card (name, job selector; under it the network,
or the AP's name, address, channel and phones, and *remember*).

| Button | On a card |
|---|---|
| ←/→ | choose its job: *Local LAN (ES)* or *Idle*, *AP 2.4 GHz*, *AP 5 GHz* if it has 5 GHz |
| A | apply (asks first; says when the handheld would leave its network) |
| Y | remember on/off |

SETUP shows the result, read-only. No Wi-Fi password anywhere.

### Feed ⇄ engine

- `LIMB|key|name|driver|job|ap_ok|bands|band|remember|iface|info|clients`
  (job: `lan`, `ap`, `idle`, `off`; bands: 1 = 2.4 GHz, 2 = 5 GHz, added)
- `LIMB_JOB|key|ap|bg` · `LIMB_JOB|key|ap|a` · `LIMB_JOB|key|off`
- `LIMB_REMEMBER|key|1` / `|0`
- `AP|` and `SSID|` stay (header, QR code).

## Devices asked about

| Device | Verdict |
|---|---|
| Blueway High Power (RT3070) | **Works**: in dArkOS's kernel, AP mode reported |
| TP-Link Archer T3U (RTL8812BU) | No driver in the 4.4 kernel; an outside driver would have to be built for 4.4.189 |
| TP-Link Archer TX10UB Nano (Wi-Fi 6) | Needs a much newer kernel: not realistic |
| RTL-SDR Blog V3 | Not Wi-Fi: a receive-only radio. A possible *RF monitor* limb for our own mesh (the LoRa band), never for tracking anyone's devices. Separate plan |
| For 5 GHz without driver work | Ralink **RT5572** (same driver family as the Blueway) or Atheros **AR9271** (2.4 GHz only). Check with `lsusb; iw dev; iw list` once plugged in |

## Open decisions

1. **Names of extra APs**: one name for all (phones see "one" network), or
   `-2`, `-3`… (the default for now)?
2. **Remember** on by default for a new AP, or off (the default for now)?

## Steps

- [x] Read-only ES network; no SSID/password picker (from R36MAX-Stump PR #4)
- [x] This plan
- [ ] `limbs.py`: cards (MAC, driver, USB id, AP modes, bands), jobs, AP
      connections per card, slots and channels, remember, hotplug
- [ ] The feed: `LIMB|` lines, `LIMB_JOB` / `LIMB_REMEMBER`, one Stump restart
      per change; `AP_ON` / `AP_OFF` kept for the old buttons
- [ ] The engine: NETWORK tab rows per card, the confirm, SETUP read-only
- [ ] `install.sh`: DNS option `0.0.0.0` for every AP
- [ ] Tests: `iw` output from the R36MAX itself, a 5 GHz card, sysfs and
      nmcli fakes, take-over, N APs, remember, hotplug
- [ ] Bench, then a release in R36MAX-Stump

## Bench

On the R36MAX, after installing from this repo:

1. Blueway only: the NETWORK tab lists it as *Local LAN (ES)*, AP-capable.
2. AP on it: the warning, phones see the AP, sign-in page; AP off → back on
   ES's network.
3. Remember on, unplug and replug: the AP comes back without the cockpit.
4. With a second card (when there is one): two APs, `10.42.0.x` and
   `10.42.1.x`, the sign-in page on both.
