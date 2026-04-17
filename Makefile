UUID    := mertnotch@mertdlkr
PREFIX  := $(HOME)/.local/share/gnome-shell/extensions
DEST    := $(PREFIX)/$(UUID)
FILES   := metadata.json extension.js notch.js prefs.js stylesheet.css \
           modules schemas

.PHONY: all compile-schemas install uninstall pack reload enable disable logs clean

all: compile-schemas

compile-schemas:
	glib-compile-schemas schemas/

install: compile-schemas
	mkdir -p "$(DEST)"
	cp -r $(FILES) "$(DEST)/"

uninstall:
	rm -rf "$(DEST)"

pack: compile-schemas
	rm -f $(UUID).shell-extension.zip
	zip -r $(UUID).shell-extension.zip $(FILES) -x '*.xml'
	@echo "Built $(UUID).shell-extension.zip"

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

reload: install
	@echo "Log out / log in (Wayland) or press Alt+F2 → r (X11) to reload GNOME Shell."

logs:
	journalctl -f -o cat /usr/bin/gnome-shell

clean:
	rm -f schemas/gschemas.compiled
	rm -f $(UUID).shell-extension.zip
