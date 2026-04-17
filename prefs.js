import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/prefs.js';

export default class MertNotchPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

        const modGroup = new Adw.PreferencesGroup({title: 'Modules', description: 'Enable or disable notch features'});
        modGroup.add(this._boolRow(settings, 'show-system',        'System monitor pill'));
        modGroup.add(this._boolRow(settings, 'show-dropshelf',     'File drop shelf'));
        modGroup.add(this._boolRow(settings, 'show-notifications', 'Dynamic notification peek'));
        modGroup.add(this._boolRow(settings, 'show-calendar',      'Google Calendar peek'));
        modGroup.add(this._boolRow(settings, 'show-tasks',         'Google Tasks peek'));
        page.add(modGroup);

        const sizeGroup = new Adw.PreferencesGroup({title: 'Size & Performance'});
        sizeGroup.add(this._intRow(settings, 'collapsed-width', 'Collapsed width',  180, 420, 10));
        sizeGroup.add(this._intRow(settings, 'expanded-width',  'Expanded width',   400, 900, 20));
        sizeGroup.add(this._intRow(settings, 'poll-interval',   'Poll interval (s)', 1,  30,  1));
        page.add(sizeGroup);

        const acctGroup = new Adw.PreferencesGroup({title: 'Google Tasks'});
        const entry = new Adw.EntryRow({title: 'GOA account email (for Tasks sync)'});
        settings.bind('tasks-account', entry, 'text', 0);
        acctGroup.add(entry);
        page.add(acctGroup);

        window.add(page);
    }

    _boolRow(settings, key, title) {
        const row = new Adw.SwitchRow({title});
        settings.bind(key, row, 'active', 0);
        return row;
    }

    _intRow(settings, key, title, min, max, step) {
        const row = new Adw.SpinRow({
            title,
            adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step}),
        });
        settings.bind(key, row, 'value', 0);
        return row;
    }
}
