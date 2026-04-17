# MertNotch

MacBook-style interactive notch for GNOME 49+. A tiny always-visible pill that
expands on hover, showing system stats, a file drop shelf, Google Calendar, and
Google Tasks. Dynamic notification peeks appear in the notch itself.

## Status

v0.1.0 — initial scaffold. What works:

- System pill (CPU / RAM / Net from `/proc`, 3 s poll)
- Hover expand / collapse animation
- Tabbed expanded panel (System / Shelf / Calendar / Tasks)
- Notification peek via `MessageTray.source-added`
- Google Calendar via `org.gnome.Shell.CalendarServer` D-Bus (works out of the
  box because your GOA accounts already feed evolution-data-server)
- Preferences (module toggles, size, poll interval)

What is stubbed and needs finishing:

- File drop shelf: manual `addFile(path)` works; wiring the notch actor as an
  XDnd drop target so you can drag files from Nautilus onto the notch is next.
- Google Tasks: reads from an empty in-memory list. Needs a GOA `GetAccessToken`
  call + `libsoup` fetch to `tasks.googleapis.com`.

## Install (dev)

```sh
make install
# then log out / log in (Wayland) — GNOME Shell reload required
gnome-extensions enable mertnotch@mertdlkr
```

Pack for distribution:

```sh
make pack
```

## Performance targets

- Idle CPU < 0.1 %
- Idle RAM < 15 MB
- System poll 3 s (configurable)
- Calendar refresh 5 min (EDS keeps its own cache warm)
- Notifications are event-driven, no polling

## Hiding Vitals

Once this is live you can disable the top-bar Vitals extension:

```sh
gnome-extensions disable Vitals@CoreCoding.com
```

## Layout

```
mertnotch@mertdlkr/
├── metadata.json
├── extension.js          # enable/disable, mounts Notch into panel center
├── notch.js              # collapsed pill + expanded tabbed panel
├── modules/
│   ├── system.js         # /proc reader, emits 'updated'
│   ├── dropshelf.js      # file tray under ~/.cache/mertnotch/shelf/
│   ├── notifications.js  # MessageTray peek
│   └── calendar.js       # Shell CalendarServer D-Bus + Google Tasks (stub)
├── prefs.js              # Adwaita preferences
├── schemas/
│   └── org.gnome.shell.extensions.mertnotch.gschema.xml
├── stylesheet.css
└── Makefile
```
