import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

export const Notes = GObject.registerClass(
class Notes extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._saveTimer = 0;
    }

    start() {}
    stop() { this._flush(); if (this._saveTimer) { GLib.source_remove(this._saveTimer); this._saveTimer = 0; } }
    destroy() { this.stop(); }

    render() {
        const box = new St.BoxLayout({style_class: 'mertnotch-notes', vertical: true, x_expand: true, y_expand: true});
        const entry = new St.Entry({
            style_class: 'mertnotch-notes-entry',
            hint_text: 'Type, edit, save. Persists across reboots.',
            x_expand: true,
            y_expand: true,
            can_focus: true,
        });
        const clutterText = entry.get_clutter_text();
        clutterText.set_single_line_mode(false);
        clutterText.set_activatable(false);
        clutterText.set_line_wrap(true);
        clutterText.set_line_wrap_mode(2);
        entry.set_text(this._settings.get_string('notes-content'));
        clutterText.connect('text-changed', () => this._debouncedSave(clutterText.get_text()));
        box.add_child(entry);

        const footer = new St.BoxLayout({style_class: 'mertnotch-notes-footer'});
        const info = new St.Label({text: 'Saved automatically', style_class: 'mertnotch-notes-info', x_expand: true});
        footer.add_child(info);
        const clear = new St.Button({style_class: 'mertnotch-notes-clear', label: 'Clear'});
        clear.connect('clicked', () => {
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
