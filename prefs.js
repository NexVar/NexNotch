import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/prefs.js';

import {listGoogleAccounts} from './modules/goa.js';

export default class MertNotchPrefs extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

        const modGroup = new Adw.PreferencesGroup({title: 'Modules'});
        modGroup.add(this._boolRow(settings, 'show-system',        'System monitor'));
        modGroup.add(this._boolRow(settings, 'show-dropshelf',     'File drop shelf'));
        modGroup.add(this._boolRow(settings, 'show-notifications', 'Dynamic notification peek'));
        modGroup.add(this._boolRow(settings, 'show-calendar',      'Google Calendar'));
        modGroup.add(this._boolRow(settings, 'show-tasks',         'Google Tasks'));
        page.add(modGroup);

        const sizeGroup = new Adw.PreferencesGroup({title: 'Size & Performance'});
        sizeGroup.add(this._intRow(settings, 'collapsed-width', 'Collapsed width',  120, 360, 10));
        sizeGroup.add(this._intRow(settings, 'expanded-width',  'Expanded width',   400, 900, 20));
        sizeGroup.add(this._intRow(settings, 'poll-interval',   'System poll (s)',   1,  30,  1));
        page.add(sizeGroup);

        const notifGroup = new Adw.PreferencesGroup({
            title: 'Notifications',
            description: 'Force-close stuck banner notifications',
        });
        notifGroup.add(this._intRow(settings, 'notif-auto-dismiss', 'Auto-dismiss after (s)', 0, 120, 1));
        page.add(notifGroup);

        const shelfPage = new Adw.PreferencesPage({title: 'Drop Shelf', icon_name: 'folder-download-symbolic'});
        const destGroup = new Adw.PreferencesGroup({
            title: 'Destination',
            description: 'Where files dropped onto the notch are sent',
        });

        const destRow = new Adw.ComboRow({title: 'Destination'});
        const destModel = new Gtk.StringList();
        destModel.append('Local shelf only');
        destModel.append('Google Drive');
        destModel.append('Local + Google Drive');
        destRow.set_model(destModel);
        const destMap = ['local', 'drive', 'local+drive'];
        destRow.set_selected(destMap.indexOf(settings.get_string('dropshelf-destination')));
        destRow.connect('notify::selected', () => {
            settings.set_string('dropshelf-destination', destMap[destRow.get_selected()]);
        });
        destGroup.add(destRow);

        const acctRow = new Adw.ComboRow({title: 'Google account'});
        const acctModel = new Gtk.StringList();
        const accounts = await listGoogleAccounts().catch(() => []);
        const acctEmails = accounts.map(a => a.email);
        if (acctEmails.length === 0) acctModel.append('(no Google accounts in GOA)');
        else for (const e of acctEmails) acctModel.append(e);
        acctRow.set_model(acctModel);
        const saved = settings.get_string('dropshelf-account');
        if (saved && acctEmails.includes(saved)) acctRow.set_selected(acctEmails.indexOf(saved));
        acctRow.connect('notify::selected', () => {
            const idx = acctRow.get_selected();
            if (acctEmails[idx]) settings.set_string('dropshelf-account', acctEmails[idx]);
        });
        destGroup.add(acctRow);

        const folderRow = new Adw.EntryRow({title: 'Drive folder ID (root = My Drive)'});
        settings.bind('dropshelf-drive-folder', folderRow, 'text', 0);
        destGroup.add(folderRow);

        shelfPage.add(destGroup);
        window.add(page);
        window.add(shelfPage);
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
