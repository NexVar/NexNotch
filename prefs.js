import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/prefs.js';

import {listGoogleAccounts} from './modules/goa.js';

export default class MertNotchPrefs extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(720, 720);

        window.add(this._generalPage(settings));
        window.add(this._appearancePage(settings));
        window.add(this._clockPage(settings));
        window.add(await this._shelfPage(settings));
        window.add(this._notifPage(settings));
        window.add(this._weatherPage(settings));
        window.add(this._pomodoroPage(settings));
        window.add(this._keybindPage(settings));
    }

    _generalPage(settings) {
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

        const modGroup = new Adw.PreferencesGroup({title: 'Modules'});
        modGroup.add(this._boolRow(settings, 'show-system',        'System monitor'));
        modGroup.add(this._boolRow(settings, 'show-dropshelf',     'File drop shelf'));
        modGroup.add(this._boolRow(settings, 'show-notifications', 'Dynamic notification peek'));
        modGroup.add(this._boolRow(settings, 'show-calendar',      'Google Calendar'));
        modGroup.add(this._boolRow(settings, 'show-tasks',         'Google Tasks'));
        page.add(modGroup);

        const perfGroup = new Adw.PreferencesGroup({title: 'Performance'});
        perfGroup.add(this._intRow(settings, 'poll-interval', 'System poll interval (s)', 1, 30, 1,
            '1s = real-time like Vitals; 3s = lighter.'));
        page.add(perfGroup);

        const panelGroup = new Adw.PreferencesGroup({title: 'Panel integration'});
        panelGroup.add(this._boolRow(settings, 'hide-datemenu',
            'Hide built-in GNOME clock (replace with notch)'));
        page.add(panelGroup);

        return page;
    }

    _appearancePage(settings) {
        const page = new Adw.PreferencesPage({title: 'Appearance', icon_name: 'applications-graphics-symbolic'});

        const sizeGroup = new Adw.PreferencesGroup({title: 'Size'});
        sizeGroup.add(this._intRow(settings, 'collapsed-width',  'Collapsed width',   140, 480, 5));
        sizeGroup.add(this._intRow(settings, 'collapsed-height', 'Collapsed height',   24,  56, 1));
        sizeGroup.add(this._intRow(settings, 'expanded-width',   'Expanded width',    420, 960, 10));
        sizeGroup.add(this._intRow(settings, 'expanded-height',  'Expanded height',   200, 480, 10));
        sizeGroup.add(this._intRow(settings, 'corner-radius',    'Corner radius',       0,  32, 1));
        page.add(sizeGroup);

        const colorGroup = new Adw.PreferencesGroup({
            title: 'Colors',
            description: 'Pick any color + opacity. Presets give Apple-like looks instantly.',
        });
        colorGroup.add(this._colorRow(settings, 'bg-color',     'Background color'));
        colorGroup.add(this._colorRow(settings, 'accent-color', 'Accent color'));

        const presets = new Adw.ActionRow({title: 'Presets'});
        for (const [label, bg, ac] of [
            ['Apple black',  'rgba(0, 0, 0, 0.85)',        'rgba(120, 170, 255, 0.28)'],
            ['True black',   'rgba(0, 0, 0, 1.00)',        'rgba(140, 190, 255, 0.35)'],
            ['Graphite',     'rgba(22, 22, 26, 0.92)',     'rgba(180, 180, 190, 0.22)'],
            ['Nord',         'rgba(46, 52, 64, 0.92)',     'rgba(136, 192, 208, 0.30)'],
            ['Dracula',      'rgba(40, 42, 54, 0.92)',     'rgba(189, 147, 249, 0.32)'],
        ]) {
            const btn = new Gtk.Button({label, css_classes: ['pill']});
            btn.connect('clicked', () => {
                settings.set_string('bg-color', bg);
                settings.set_string('accent-color', ac);
            });
            presets.add_suffix(btn);
        }
        colorGroup.add(presets);
        page.add(colorGroup);

        const battGroup = new Adw.PreferencesGroup({
            title: 'Battery icon colors',
            description: 'Colour of the battery indicator in the collapsed pill.',
        });
        battGroup.add(this._colorRow(settings, 'battery-charging-color', 'Charging'));
        battGroup.add(this._colorRow(settings, 'battery-normal-color',   'Discharging'));
        battGroup.add(this._colorRow(settings, 'battery-low-color',      'Low (<20%)'));
        page.add(battGroup);

        return page;
    }

    _weatherPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Weather', icon_name: 'weather-few-clouds-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: 'Weather',
            description: 'Powered by wttr.in — no API key needed.',
        });
        const loc = new Adw.EntryRow({title: 'Location (city name, or "lat,lon"; empty = IP auto-detect)'});
        settings.bind('weather-location', loc, 'text', 0);
        group.add(loc);

        const unit = new Adw.ComboRow({title: 'Units'});
        const unitModel = new Gtk.StringList();
        unitModel.append('Metric (°C, km/h)');
        unitModel.append('Imperial (°F, mph)');
        unit.set_model(unitModel);
        unit.set_selected(settings.get_string('weather-unit') === 'imperial' ? 1 : 0);
        unit.connect('notify::selected', () => {
            settings.set_string('weather-unit', unit.get_selected() === 1 ? 'imperial' : 'metric');
        });
        group.add(unit);

        group.add(this._intRow(settings, 'weather-refresh', 'Refresh interval (min)', 5, 240, 5));
        page.add(group);
        return page;
    }

    _pomodoroPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Pomodoro', icon_name: 'alarm-symbolic'});
        const group = new Adw.PreferencesGroup({title: 'Pomodoro timings'});
        group.add(this._intRow(settings, 'pomodoro-work',   'Work duration (min)',       1, 180, 1));
        group.add(this._intRow(settings, 'pomodoro-break',  'Short break (min)',         1,  60, 1));
        group.add(this._intRow(settings, 'pomodoro-long',   'Long break (min)',          1,  60, 1));
        group.add(this._intRow(settings, 'pomodoro-cycles', 'Cycles before long break',  1,  10, 1));
        page.add(group);
        return page;
    }

    _keybindPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Shortcuts', icon_name: 'input-keyboard-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: 'Global shortcuts',
            description: 'Edit with accelerator syntax, e.g. <Super><Shift>d',
        });

        const fp = new Adw.EntryRow({title: 'Open file picker → add to shelf'});
        fp.set_text((settings.get_strv('shortcut-filepicker')[0]) ?? '');
        fp.connect('changed', () => {
            settings.set_strv('shortcut-filepicker', [fp.get_text()]);
        });
        group.add(fp);

        const tg = new Adw.EntryRow({title: 'Toggle notch (expand / collapse)'});
        tg.set_text((settings.get_strv('shortcut-toggle')[0]) ?? '');
        tg.connect('changed', () => {
            settings.set_strv('shortcut-toggle', [tg.get_text()]);
        });
        group.add(tg);

        page.add(group);
        return page;
    }

    _clockPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Clock', icon_name: 'alarm-symbolic'});

        const group = new Adw.PreferencesGroup({title: 'Clock'});
        group.add(this._boolRow(settings, 'show-date',    'Show date in collapsed pill'));
        group.add(this._boolRow(settings, 'show-seconds', 'Show seconds (updates every second)'));

        const fmt = new Adw.ComboRow({title: '12h / 24h format'});
        const fmtModel = new Gtk.StringList();
        fmtModel.append('24h'); fmtModel.append('12h');
        fmt.set_model(fmtModel);
        fmt.set_selected(settings.get_string('clock-format') === '12h' ? 1 : 0);
        fmt.connect('notify::selected', () => {
            settings.set_string('clock-format', fmt.get_selected() === 1 ? '12h' : '24h');
        });
        group.add(fmt);

        page.add(group);
        return page;
    }

    async _shelfPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Drop Shelf', icon_name: 'folder-download-symbolic'});

        const destGroup = new Adw.PreferencesGroup({
            title: 'Destination',
            description: 'Where files dropped onto the notch are sent. Configured once, applies to every drop.',
        });

        const destRow = new Adw.ComboRow({title: 'Destination'});
        const destModel = new Gtk.StringList();
        destModel.append('Local shelf only');
        destModel.append('Google Drive');
        destModel.append('Local + Google Drive');
        destRow.set_model(destModel);
        const destMap = ['local', 'drive', 'local+drive'];
        destRow.set_selected(Math.max(0, destMap.indexOf(settings.get_string('dropshelf-destination'))));
        destRow.connect('notify::selected', () => {
            settings.set_string('dropshelf-destination', destMap[destRow.get_selected()]);
        });
        destGroup.add(destRow);

        const acctRow = new Adw.ComboRow({title: 'Google account (for Drive)'});
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

        destGroup.add(this._boolRow(settings, 'dropshelf-delete-after',
            'Delete local copy after successful Drive upload'));

        page.add(destGroup);
        return page;
    }

    _notifPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Notifications', icon_name: 'preferences-system-notifications-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: 'Notifications',
            description: 'MertNotch force-closes non-critical banners after this timeout. Fixes the Fedora-45+ bug where banners never auto-dismiss.',
        });
        group.add(this._intRow(settings, 'notif-auto-dismiss', 'Auto-dismiss after (s, 0 = off)', 0, 120, 1));
        page.add(group);
        return page;
    }

    /* —— row builders —— */

    _boolRow(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title});
        if (subtitle) row.set_subtitle(subtitle);
        settings.bind(key, row, 'active', 0);
        return row;
    }

    _intRow(settings, key, title, min, max, step, subtitle) {
        const row = new Adw.SpinRow({
            title,
            adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step}),
        });
        if (subtitle) row.set_subtitle(subtitle);
        settings.bind(key, row, 'value', 0);
        return row;
    }

    _colorRow(settings, key, title) {
        const row = new Adw.ActionRow({title, subtitle: settings.get_string(key)});
        const btn = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({title, with_alpha: true}),
        });
        btn.set_rgba(this._parseRgba(settings.get_string(key)));
        btn.connect('notify::rgba', () => {
            const rgba = btn.get_rgba();
            const s = this._rgbaToString(rgba);
            settings.set_string(key, s);
            row.set_subtitle(s);
        });
        settings.connect(`changed::${key}`, () => {
            btn.set_rgba(this._parseRgba(settings.get_string(key)));
            row.set_subtitle(settings.get_string(key));
        });
        row.add_suffix(btn);
        return row;
    }

    _parseRgba(str) {
        const rgba = new Gdk.RGBA();
        rgba.parse(str);
        return rgba;
    }

    _rgbaToString(rgba) {
        const r = Math.round(rgba.red   * 255);
        const g = Math.round(rgba.green * 255);
        const b = Math.round(rgba.blue  * 255);
        const a = rgba.alpha.toFixed(2);
        return `rgba(${r}, ${g}, ${b}, ${a})`;
    }
}
