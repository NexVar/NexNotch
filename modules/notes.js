import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const Notes = GObject.registerClass(
class Notes extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._saveTimer = 0;
        this._grab = null;
        this._grabActor = null;
    }

    setGrabActor(actor) { this._grabActor = actor; }

    start() {}
    stop() {
        this._releaseGrab();
        this._flush();
        if (this._saveTimer) { GLib.source_remove(this._saveTimer); this._saveTimer = 0; }
    }
    destroy() { this.stop(); }

    _pushGrab() {
        if (this._grab || !this._grabActor) return;
        try {
            this._grab = Main.pushModal(this._grabActor, {
                actionMode: 1 << 1,  /* Shell.ActionMode.NORMAL */
            });
        } catch (_) {}
    }

    _releaseGrab() {
        if (!this._grab) return;
        try {
            if (typeof Main.popModal === 'function') Main.popModal(this._grab);
        } catch (_) {}
        this._grab = null;
        if (this._grabActor) this._grabActor._notesFocused = false;
    }

    render() {
        const box = new St.BoxLayout({style_class: 'nexnotch-notes', vertical: true, x_expand: true, y_expand: true});
        const entry = new St.Entry({
            style_class: 'nexnotch-notes-entry',
            hint_text: 'Click here and type. Saves automatically.',
            x_expand: true,
            y_expand: true,
            can_focus: true,
            reactive: true,
            track_hover: true,
        });
        const clutterText = entry.get_clutter_text();
        clutterText.reactive = true;
        clutterText.set_single_line_mode(false);
        clutterText.set_activatable(false);
        clutterText.set_editable(true);
        clutterText.set_line_wrap(true);
        clutterText.set_line_wrap_mode(2);
        clutterText.set_selectable(true);
        clutterText.set_text(this._settings.get_string('notes-content'));
        clutterText.connect('text-changed', () => this._debouncedSave(clutterText.get_text()));

        /* Top-chrome actors don't win key focus on their own. Pushing a modal
           grab (like Main.runDialog does) routes keyboard input to the entry
           until the user clicks out or presses Escape. */
        const focusEntry = () => {
            this._pushGrab();
            try {
                global.stage.set_key_focus(clutterText);
                clutterText.grab_key_focus();
            } catch (_) {}
            /* Signal the notch not to collapse while we're typing. */
            if (this._grabActor) this._grabActor._notesFocused = true;
        };
        const blurEntry = () => {
            if (this._grabActor) this._grabActor._notesFocused = false;
        };
        /* key-focus-in covers keyboard tabbing into the entry, which the
           button-press wiring alone misses. Both paths now set the flag. */
        clutterText.connect('key-focus-in', () => {
            if (this._grabActor) this._grabActor._notesFocused = true;
        });
        clutterText.connect('key-focus-out', blurEntry);
        entry.connect('button-press-event', () => { focusEntry(); return Clutter.EVENT_PROPAGATE; });
        clutterText.connect('button-press-event', () => { focusEntry(); return Clutter.EVENT_PROPAGATE; });
        clutterText.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._releaseGrab();
                try { global.stage.set_key_focus(null); } catch (_) {}
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        box.add_child(entry);

        const footer = new St.BoxLayout({style_class: 'nexnotch-notes-footer'});
        const info = new St.Label({text: 'Saved automatically', style_class: 'nexnotch-notes-info', x_expand: true});
        footer.add_child(info);
        const clear = new St.Button({
            style_class: 'nexnotch-notes-clear',
            label: 'Clear',
            accessible_name: 'Clear all notes',
            can_focus: true,
        });
        clear.connect('clicked', () => {
            /* Cancel any pending debounced save so it can't overwrite the
               clear with the previous text. */
            if (this._saveTimer) { GLib.source_remove(this._saveTimer); this._saveTimer = 0; }
            clutterText.set_text('');
            this._settings.set_string('notes-content', '');
        });
        footer.add_child(clear);
        box.add_child(footer);

        return box;
    }

    _debouncedSave(text) {
        if (this._saveTimer) GLib.source_remove(this._saveTimer);
        this._saveTimer = GLib.timeout_add(GLib.PRIORITY_LOW, 600, () => {
            this._saveTimer = 0;
            this._settings.set_string('notes-content', text);
            return GLib.SOURCE_REMOVE;
        });
    }

    _flush() {
        // settings writes already flush; this is a no-op placeholder
    }
});
