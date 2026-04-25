# NexNotch — Dynamic Island for GNOME

[![GNOME Shell 49](https://img.shields.io/badge/GNOME%20Shell-49%20%7C%2050-4A86CF?logo=gnome&logoColor=white)](https://www.gnome.org/)
[![License: GPL-3.0+](https://img.shields.io/badge/License-GPL--3.0%2B-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Built by NexVar](https://img.shields.io/badge/built%20by-NexVar-0a0a0a?labelColor=000)](https://nexvar.io)
[![Wayland Ready](https://img.shields.io/badge/Wayland-ready-success)](#)
[![X11 Compatible](https://img.shields.io/badge/X11-compatible-success)](#)

**Bring the iPhone Dynamic Island vibe to your Linux desktop.**

NexNotch is a MacBook-notch-shaped pill that replaces the GNOME top-bar clock and expands on hover into a tabbed productivity hub. Live system stats, Google Calendar & Tasks (via GNOME Online Accounts — no extra login), dual-city weather, a Pomodoro timer with a full stats dashboard, sticky notes, a file drop shelf with optional Drive upload, a notification peek with click-to-activate, and a quick-actions panel for privacy indicators and system controls — all in a single, beautiful, hover-expanding component that feels native to GNOME 49+.

> Built at **[NexVar](https://nexvar.io)** by **[Mert Ali Dalkır](https://mertdlkr.com)** — the polished desktop tooling we use ourselves.

---

## Why NexNotch?

GNOME's top bar is wasted space. macOS turned its notch into a Dynamic Island. NexNotch does the same for Linux — a single hover-expanding component that replaces a dozen separate extensions with one cohesive, performant, beautifully-designed hub.

- **Idle CPU < 0.1 %** — lighter than most single-purpose extensions
- **Idle RAM < 15 MB** — no Electron, no bloat
- **Native GNOME Shell** — pure JavaScript on top of St/Clutter/GObject
- **Wayland & X11** — both work end-to-end (with a known limitation around Wayland external drag-and-drop, see below)
- **9-page preferences window** — every behavior is configurable

---

## What's inside the notch

Hover the pill (or press `Super + N`) to expand into 7 tabs:

| Tab | What it does |
|---|---|
| **System** | Live CPU, RAM, uptime, battery time-remaining, network throughput, disk I/O, CPU temperature, load average, swap. 1-second update loop, full Vitals parity. |
| **Calendar / Tasks** | Reads your Google Calendar events and Google Tasks through your existing GNOME Online Accounts setup. **No extra login.** Per-account filtering. |
| **Weather** | **Dual-location** for people splitting time between two cities. Free wttr.in backend. Accepts city names, districts, GPS coordinates, airport codes. |
| **Pomodoro** | Configurable presets (50/10, 25/5, 10/2 by default — add your own). JSONL session log. |
| **Stats** | Pomodoro dashboard: today, week chart, current streak, peak hour. Cached 30 s. |
| **Notes** | Sticky-note text area, auto-save, keyboard-accessible. Pushes a modal grab so typing doesn't leak to the desktop. |
| **Shelf** | File picker + `+ Add` button. Send files to a mounted folder (e.g. a GVFS-mounted Google Drive) or upload directly to Drive via GOA OAuth. Async file copies. |
| **Quick** | Microphone / camera-in-use privacy pills, Bluetooth device battery percentages, keyboard layout indicator, Do-Not-Disturb toggle, and **two-tap armed** Log out / Reboot / Shutdown. |

Plus a **notification peek** — when a notification arrives, NexNotch shows a slim peek inside the pill with the app icon, title, body, and time. Click it to activate the notification natively. Optionally suppresses the standard banner if your DE (looking at you, Fedora) leaves it stuck.

---

## Install

### Option A — extensions.gnome.org (recommended, once approved)

```sh
# Search "NexNotch" on extensions.gnome.org and click Install
# Or via CLI:
gnome-extensions install --enable nexnotch@nexvar
```

> ⚠️ Pending review by GNOME extension reviewers. Until approved, use Option B.

### Option B — Manual install from source

```sh
git clone https://github.com/NexVar/NexNotch.git
cd NexNotch
make install
# Log out → log in (Wayland needs a session restart)
gnome-extensions enable nexnotch@nexvar
gnome-extensions prefs nexnotch@nexvar
```

Optional — disable redundant extensions once NexNotch is doing their job:

```sh
gnome-extensions disable Vitals@CoreCoding.com    # NexNotch System tab covers this
```

### Option C — Pack a zip yourself

```sh
make pack       # produces nexnotch@nexvar.shell-extension.zip
```

Then upload via [extensions.gnome.org/upload](https://extensions.gnome.org/upload/) for review, or install locally with `gnome-extensions install ./nexnotch@nexvar.shell-extension.zip`.

---

## Global keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Super + Shift + D` | Open file picker, add selection to the shelf |
| `Super + N` | Toggle notch expand / collapse |

Both are remappable from the **Shortcuts** page in preferences.

---

## Preferences (9 pages)

1. **General** — module toggles, poll interval, hide GNOME clock
2. **Appearance** — size sliders, alpha-aware color pickers, presets (Apple / True Black / Graphite / Nord / Dracula), battery-icon colors
3. **Clock** — show date, show seconds, 12h / 24h toggle
4. **Drop Shelf** — destination (local folder / mounted GVFS / OAuth Drive), GOA account picker, folder path picker, delete-after-upload
5. **Notifications** — auto-dismiss TTL, native-banner suppression, DND state mirror
6. **Weather** — primary + secondary location, units, refresh rate
7. **Pomodoro** — preset manager, long break duration, cycles before long break
8. **Calendar & Tasks** — one-toggle-per-account sync filter, "Open GNOME Settings" shortcut for unconnected accounts
9. **Shortcuts** — accelerator strings for the two global keybinds

---

## Performance targets

- **Idle CPU**: less than 0.1%
- **Idle RAM**: less than 15 MB
- **System poll**: configurable, default 1 second (Vitals parity)
- **Calendar events**: auto-refresh via Shell `CalendarServer` push (no polling)
- **Quick tab**: pacts/fuser/upower polled at 15 seconds
- **Weather**: 30-minute refresh
- **Stats**: 30-second cache on JSONL read
- **All file copies**: async (`file.copy_async`)
- **Idle + peek timers**: scheduled on real second/minute boundaries (no jitter)

Heavy work runs through `Gio.Cancellable`, so enabling/disabling never leaves pending async calls on stale objects. Modules whose feature toggle is off are cleanly stopped — no background polling for features you turned off.

---

## Architecture

```
nexnotch@nexvar/
├── metadata.json              # shell-version: 49, 50
├── extension.js               # enable/disable; addTopChrome mount,
│                              # monitor tracking, EDS autostart
├── notch.js                   # St.Widget: collapsed pill + expanded
│                              # tabbed panel, hover + DND + keybinds,
│                              # notification peek with click-to-activate
├── modules/
│   ├── system.js              # /proc CPU/mem/net/disk + hwmon thermals,
│   │                          # AC-adapter sensing, battery time remaining
│   ├── dropshelf.js           # async file copy buffer + folder destination
│   │                          # or OAuth Drive upload via libsoup3
│   ├── notifications.js       # MessageTray peek + auto-destroy + banner kill
│   ├── mpris.js               # MediaPlayer2 watcher → media icon
│   ├── calendar.js            # Shell.CalendarServer events +
│   │                          # ECal TASK_LIST query (via libecal GIR)
│   ├── notes.js               # persistent textarea, Main.pushModal grab
│   ├── weather.js             # wttr.in dual-location fetch (libsoup3)
│   ├── pomodoro.js            # presets + JSONL session log
│   ├── stats.js               # pomodoro dashboard: today/week/streak + chart
│   ├── quick.js               # pactl / fuser / upower polls + DND toggle
│   └── goa.js                 # ObjectManager walk + OAuth2 access token
├── prefs.js                   # Adw 9-page preferences window
├── schemas/…gschema.xml
├── stylesheet.css
└── Makefile                   # compile-schemas / install / pack / reload / logs
```

---

## Known limits

- **Wayland blocks external drag-and-drop to shell widgets**, so dropping files directly onto the notch from GTK4 Nautilus will not work. Use `+ Add` in the shelf header, or `Super + Shift + D`. XWayland apps still fire `Main.xdndHandler.drag-begin`, so the notch auto-expands on drag, making the `+` button obvious.
- **Evolution Data Server's `org.gnome.evolution.dataserver.Sources5` service does not auto-activate on some Fedora setups.** `extension.js` spawns `evolution-source-registry` at enable time as a workaround (idempotent — second instance exits immediately).
- **blur-my-shell panel blur** used to bleed through the notch — fixed by mounting into `Main.layoutManager.addTopChrome` instead of `Main.panel._centerBox`.

---

## Dependencies

**Required:**
- GNOME Shell 49 or 50
- GLib, GTK 4, Adwaita (already required by shell)

**Optional — feature gracefully degrades if missing:**
- `libsoup3` — weather + optional Drive upload
- `libecal` / evolution-data-server — Google Tasks (typically present via GOA already)
- `zenity`, `pactl`, `fuser`, `upower`, `notify-send` — Quick tab features

All external commands are guarded with `GLib.find_program_in_path()` — missing tools degrade silently instead of throwing.

**Network calls:** none, except user-triggered wttr.in weather fetch and optional Google Drive upload. **GOA access tokens** are cached in-memory for 30 seconds less than their TTL and never written to disk.

---

## Contributing

PRs welcome. NexNotch follows a small, opinionated style:

- Pure ES modules, no build step (GNOME loads `.js` directly)
- Each module owns its own `start()` / `stop()` lifecycle, registers `Gio.Cancellable`s
- Settings keys live in `schemas/*.gschema.xml`, accessed via `Gio.Settings`
- All async I/O uses GLib async primitives (`load_contents_async`, `copy_async`)
- No npm, no node_modules, no transpiler — keeps the install zip tiny

Run `make logs` to tail GNOME Shell logs while developing.

---

## Built By

### [NexVar](https://nexvar.io)

AI-first software studio shipping production tooling, AI platforms, and developer infrastructure. NexNotch is the desktop tooling we use ourselves — a 4800-line GNOME shell extension we polished while we were already daily-driving it.

[![Website](https://img.shields.io/badge/nexvar.io-000?style=flat&logo=safari&logoColor=white)](https://nexvar.io)
[![GitHub](https://img.shields.io/badge/NexVar-181717?style=flat&logo=github&logoColor=white)](https://github.com/NexVar)

### [Mert Ali Dalkır](https://mertdlkr.com)

Creator and maintainer. Co-founder of NexVar. Builder of useful, well-engineered desktop tooling for Linux.

[![Website](https://img.shields.io/badge/mertdlkr.com-000?style=flat&logo=safari&logoColor=white)](https://mertdlkr.com)
[![X](https://img.shields.io/badge/@mertdlkr-000?style=flat&logo=x&logoColor=white)](https://x.com/mertdlkr)
[![LinkedIn](https://img.shields.io/badge/mertdlkr-0A66C2?style=flat&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/mertdlkr/)
[![GitHub](https://img.shields.io/badge/mertdlkr-181717?style=flat&logo=github&logoColor=white)](https://github.com/mertdlkr)

---

## License

GPL-3.0-or-later © [NexVar](https://nexvar.io) and [Mert Ali Dalkır](https://mertdlkr.com)

See [LICENSE](LICENSE) for the full text.

---

**If NexNotch makes your GNOME desktop better, give it a star.** It helps others find it.

Built with conviction at [nexvar.io](https://nexvar.io) and [mertdlkr.com](https://mertdlkr.com).

<!--
Discoverability keywords (for GitHub search and AI indexing):
gnome extension, gnome shell extension, gnome 49, gnome 50,
dynamic island linux, dynamic island gnome, macbook notch linux,
linux desktop customization, linux productivity,
top bar replacement, gnome panel, gnome top bar, system monitor extension,
gnome calendar extension, pomodoro timer linux, gnome weather extension,
notification center linux, fedora extension, ubuntu extension,
arch linux extension, kde alternative, gnome customize,
gnome theming, ricing linux, linux ui, gnome ui, wayland extension,
adwaita, libadwaita, gjs, st widget, clutter, gnome online accounts,
google calendar gnome, google tasks gnome, vitals replacement,
all-in-one gnome extension, mertnotch, nexnotch, nexvar
-->
