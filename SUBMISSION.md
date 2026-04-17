# extensions.gnome.org submission brief

## Package
```sh
make pack      # produces mertnotch@mertdlkr.shell-extension.zip
```
Verify the zip contains: metadata.json, extension.js, notch.js, prefs.js,
stylesheet.css, LICENSE, README.md, modules/*.js, schemas/*.gschema.xml.

## Upload form

### Name
MertNotch

### Tagline (short)
MacBook-style hover notch with system, calendar, weather, pomodoro, and more

### Description (long — paste into e.g.o form)

MertNotch replaces the GNOME top-bar clock with a compact, MacBook-notch-shaped
pill that expands on hover into a tabbed hub.

**Tabs**

- **System** — CPU, RAM, uptime, battery remaining time, network throughput,
  disk I/O, temperature, load, swap. Matches Vitals coverage with a 1-second
  real-time update loop.
- **Calendar / Tasks** — reads Google Calendar events and Tasks through your
  existing GNOME Online Accounts setup (no extra login). Filter per account.
- **Weather** — dual-location support (for people splitting their week between
  two cities), free wttr.in backend, accepts city names, districts, GPS
  coordinates, airport codes.
- **Pomodoro** — configurable presets (50/10, 25/5, 10/2 by default, add your
  own), JSONL session log, Stats tab with today / week chart / streak / peak
  hour.
- **Notes** — sticky-note text area, auto-save, keyboard-accessible.
- **Shelf** — file picker and "`+ Add`" button; send to a mounted folder
  (e.g. a GVFS-mounted Google Drive) or, optionally, upload directly to
  Google Drive via GOA OAuth.
- **Quick** — microphone / camera-in-use privacy pills, Bluetooth device
  battery percentages, keyboard layout indicator, Do-Not-Disturb toggle,
  and destructive system actions (Log out / Reboot / Shutdown) that
  require a two-tap armed confirmation.

**Notifications**

MertNotch intercepts new notifications, shows a slim peek inside the notch
with the app's icon, title, body and time, and can force-dismiss the
native banner if Fedora's notification system (or any DE) has left it
hanging. The peek is fully clickable — a left-click activates the
notification the same way a native banner click does.

**Keyboard shortcuts (user-remappable)**

- `<Super><Shift>d` — open file picker, add to shelf
- `<Super>n` — toggle expand / collapse

**Performance**

- Idle CPU < 0.1 %, idle RAM < 15 MB.
- All heavy work runs through `Gio.Cancellable`, so enabling/disabling the
  extension never leaves pending async calls on stale objects.
- Modules whose feature toggle is off are cleanly stopped — no background
  polling for features you turned off.

**Dependencies**

- GNOME Shell 49 or 50
- GLib, GTK 4, Adwaita (already required by shell)
- libsoup 3 (weather, optional Drive upload)
- libecal / evolution-data-server (Google Tasks — already present via GOA)
- `zenity`, `pactl`, `fuser`, `upower`, `notify-send` — optional, feature
  gracefully degrades if any is missing.

### Screenshot suggestions

Take these with the notch installed, at 1× display scale:

1. Collapsed pill with battery icon + clock + date visible.
2. Expanded System tab (shows the CPU/RAM/Uptime/Battery headline row).
3. Weather tab with dual-location switcher.
4. Pomodoro Timer tab with a preset selected.
5. Stats tab after running a few pomodoro sessions.
6. Drop Shelf tab with a few files queued.
7. Notification peek (`notify-send` a test notification while the notch is
   collapsed to capture this).
8. The Preferences window, Appearance page, showing the preset pills and
   colour pickers.

### License
GPL-3.0-or-later (see `LICENSE`).

### Reviewer notes

- The extension spawns `/usr/libexec/evolution-source-registry` via
  `GLib.find_program_in_path` **only if it's present and D-Bus has failed
  to auto-activate the EDS source-registry service**. It's a compatibility
  shim for Fedora setups we've seen where
  `org.gnome.evolution.dataserver.Sources5` didn't auto-start at login.
  The spawn is idempotent; a second instance exits immediately.
- External commands (`pactl`, `fuser`, `upower`, `zenity`, `notify-send`,
  `gnome-control-center`, `loginctl`, `systemctl`) are all guarded with
  `GLib.find_program_in_path()`; missing tools degrade gracefully instead
  of throwing.
- No network calls except user-triggered wttr.in weather fetch and
  optional Google Drive upload.
- GOA access tokens are cached for 30 seconds less than their TTL and
  never written to disk.
