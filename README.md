# MertNotch

MacBook-style interactive notch for GNOME 49+. Sits on top of the clock,
expands on hover into a tabbed hub covering system stats, Google Calendar,
Google Tasks, a file drop shelf, sticky notes, weather (dual-city), a
Pomodoro timer + stats dashboard, and a privacy / quick-actions panel.

## Install (dev)

```sh
make install                       # copies to ~/.local/share/gnome-shell/extensions/
# log out → log in   (Wayland needs session restart for a fresh extension load)
gnome-extensions enable mertnotch@mertdlkr
gnome-extensions prefs  mertnotch@mertdlkr
gnome-extensions disable Vitals@CoreCoding.com    # optional, now redundant
```

Pack a zip for distribution:

```sh
make pack
```

## Global shortcuts

| Shortcut | Action |
|---|---|
| `<Super><Shift>d` | Open file picker, add selection to the shelf |
| `<Super>n` | Toggle expand / collapse |

Remappable from `Shortcuts` page in preferences.

## Preferences (9 pages)

1. **General** — module toggles, poll interval, hide GNOME clock
2. **Appearance** — size sliders, colour pickers (alpha-aware), presets
   (Apple / True black / Graphite / Nord / Dracula), battery-icon colours
3. **Clock** — show-date, show-seconds, 12h / 24h
4. **Drop Shelf** — destination (local / folder / OAuth Drive),
   GOA account picker, folder path picker, delete-after-upload
5. **Notifications** — auto-dismiss TTL, native-banner suppression,
   DND state mirror
6. **Weather** — primary + secondary location, units, refresh rate
7. **Pomodoro** — preset manager (add / remove / activate), long break
   duration, cycles before long break
8. **Calendar & Tasks** — one-toggle-per-account sync filter, "Open
   GNOME Settings" shortcut if no account is connected
9. **Shortcuts** — accelerator strings for the two global keybinds

## Architecture

```
mertnotch@mertdlkr/
├── metadata.json          # shell-version: 49, 50
├── extension.js           # enable/disable; addTopChrome mount,
│                          # monitor tracking, EDS autostart
├── notch.js               # St.Widget: collapsed pill + expanded
│                          # tabbed panel, hover + DND + keybinds,
│                          # notification peek with click-to-activate
├── modules/
│   ├── system.js          # /proc CPU/mem/net/disk + hwmon thermals,
│   │                      # AC-adapter sensing, battery time remaining
│   ├── dropshelf.js       # async file copy buffer + folder destination
│   │                      # or OAuth Drive upload via libsoup3
│   ├── notifications.js   # MessageTray peek + auto-destroy + banner kill
│   ├── mpris.js           # MediaPlayer2 watcher → media icon
│   ├── calendar.js        # Shell.CalendarServer events +
│   │                      # ECal TASK_LIST query (via libecal GIR)
│   ├── notes.js           # persistent textarea, Main.pushModal grab
│   ├── weather.js         # wttr.in dual-location fetch (libsoup3)
│   ├── pomodoro.js        # presets + JSONL session log
│   ├── stats.js           # pomodoro dashboard: today/week/streak + chart
│   ├── quick.js           # pactl / fuser / upower polls + DND toggle
│   └── goa.js             # ObjectManager walk + OAuth2 access token
├── prefs.js               # Adw 9-page preferences window
├── schemas/…gschema.xml
├── stylesheet.css
├── Makefile               # compile-schemas / install / pack / reload / logs
└── .gitignore
```

## Performance targets

- Idle CPU **< 0.1 %**
- Idle RAM **< 15 MB**
- System poll configurable (default 1 s — Vitals parity)
- Calendar events auto-refresh via Shell CalendarServer push (no polling)
- Quick-tab pacts+fuser+upower poll at 15 s, Weather 30 min, Stats read
  is cached 30 s
- All file copies are async (`file.copy_async`)
- Idle + peek timers are scheduled on real second / minute boundaries

## Known limits

- **Wayland blocks external drag-and-drop to shell widgets**, so dropping
  files directly onto the notch from GTK4 Nautilus will not work. Use
  `+ Add` in the shelf header, or `<Super><Shift>d`. XWayland apps still
  fire `Main.xdndHandler.drag-begin`, so the notch does auto-expand on
  drag, making the + button obvious.
- Evolution Data Server's `org.gnome.evolution.dataserver.Sources5`
  service does not auto-activate on some Fedora setups. `extension.js`
  spawns `/usr/libexec/evolution-source-registry` at enable time as a
  workaround (idempotent).
- blur-my-shell panel blur used to bleed through the notch; fixed in
  commit `0f1a5cc` by mounting into `Main.layoutManager.addTopChrome`
  instead of `Main.panel._centerBox`.
