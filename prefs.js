import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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
        window.add(await this._accountsPage(settings));
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

        const primary = new Adw.PreferencesGroup({
            title: 'Primary location',
            description: 'Powered by wttr.in — no API key needed. Empty location falls back to IP geolocation.',
        });
        const loc = new Adw.EntryRow({title: 'City name or "lat,lon"'});
        settings.bind('weather-location', loc, 'text', 0);
        primary.add(loc);
        const lbl = new Adw.EntryRow({title: 'Friendly label (e.g. "Home")'});
        settings.bind('weather-location-label', lbl, 'text', 0);
        primary.add(lbl);
        page.add(primary);

        const secondary = new Adw.PreferencesGroup({
            title: 'Secondary location',
            description: 'For people splitting their week between two cities. Empty = disabled.',
        });
        const loc2 = new Adw.EntryRow({title: 'City name or "lat,lon"'});
        settings.bind('weather-location-2', loc2, 'text', 0);
        secondary.add(loc2);
        const lbl2 = new Adw.EntryRow({title: 'Friendly label (e.g. "Work")'});
        settings.bind('weather-location-2-label', lbl2, 'text', 0);
        secondary.add(lbl2);
        page.add(secondary);

        const opts = new Adw.PreferencesGroup({title: 'Options'});
        const unit = new Adw.ComboRow({title: 'Units'});
        const unitModel = new Gtk.StringList();
        unitModel.append('Metric (°C, km/h)');
        unitModel.append('Imperial (°F, mph)');
        unit.set_model(unitModel);
        unit.set_selected(settings.get_string('weather-unit') === 'imperial' ? 1 : 0);
        unit.connect('notify::selected', () => {
            settings.set_string('weather-unit', unit.get_selected() === 1 ? 'imperial' : 'metric');
        });
        opts.add(unit);
        opts.add(this._intRow(settings, 'weather-refresh', 'Refresh interval (min)', 5, 240, 5));
        page.add(opts);
        return page;
    }

    _pomodoroPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Pomodoro', icon_name: 'alarm-symbolic'});

        const presetGroup = new Adw.PreferencesGroup({
            title: 'Presets',
            description: 'Each preset is "work/break" minutes. Click × to remove, + to add a new one.',
        });

        const rebuild = () => {
            const children = [];
            let row = presetGroup.get_first_child();
            while (row) { children.push(row); row = row.get_next_sibling(); }
            for (const c of children) presetGroup.remove(c);

            const presets = settings.get_strv('pomodoro-presets');
            const active  = settings.get_string('pomodoro-active-preset');

            for (const p of presets) {
                const r = new Adw.ActionRow({title: p});
                if (p === active) r.set_subtitle('active');
                const activate = new Gtk.Button({label: 'Use', css_classes: ['pill']});
                activate.connect('clicked', () => {
                    settings.set_string('pomodoro-active-preset', p);
                    rebuild();
                });
                const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', css_classes: ['flat']});
                remove.connect('clicked', () => {
                    const next = presets.filter(x => x !== p);
                    if (next.length === 0) return;
                    settings.set_strv('pomodoro-presets', next);
                    if (p === active) settings.set_string('pomodoro-active-preset', next[0]);
                    rebuild();
                });
                r.add_suffix(activate);
                r.add_suffix(remove);
                presetGroup.add(r);
            }

            const addRow = new Adw.ActionRow({title: 'New preset'});
            const workEntry = new Gtk.SpinButton({
                adjustment: new Gtk.Adjustment({lower: 1, upper: 180, step_increment: 1, value: 25}),
                width_chars: 4,
            });
            const breakEntry = new Gtk.SpinButton({
                adjustment: new Gtk.Adjustment({lower: 1, upper: 60, step_increment: 1, value: 5}),
                width_chars: 4,
            });
            const addBtn = new Gtk.Button({label: 'Add', css_classes: ['suggested-action', 'pill']});
            addBtn.connect('clicked', () => {
                const w = workEntry.get_value_as_int();
                const b = breakEntry.get_value_as_int();
                const key = `${w}/${b}`;
                const cur = settings.get_strv('pomodoro-presets');
                if (!cur.includes(key)) {
                    settings.set_strv('pomodoro-presets', [...cur, key]);
                    rebuild();
                }
            });
            addRow.add_suffix(workEntry);
            addRow.add_suffix(new Gtk.Label({label: '/'}));
            addRow.add_suffix(breakEntry);
            addRow.add_suffix(addBtn);
            presetGroup.add(addRow);
        };
        rebuild();
        page.add(presetGroup);

        const longGroup = new Adw.PreferencesGroup({title: 'Long break'});
        longGroup.add(this._intRow(settings, 'pomodoro-long',   'Long break (min)',          1, 60, 1));
        longGroup.add(this._intRow(settings, 'pomodoro-cycles', 'Cycles before long break',  1, 10, 1));
        page.add(longGroup);

        return page;
    }

    async _accountsPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Accounts', icon_name: 'avatar-default-symbolic'});

        const group = new Adw.PreferencesGroup({
            title: 'Google (via GNOME Online Accounts)',
            description: 'Calendar and Tasks data flow through GOA + evolution-data-server. Add or remove accounts from GNOME Settings → Online Accounts. Toggle which accounts this extension actively syncs below.',
        });

        const accounts = await listGoogleAccounts().catch(() => []);
        const enabled = settings.get_strv('calendar-enabled-sources');

        if (accounts.length === 0) {
            const empty = new Adw.ActionRow({
                title: 'No Google accounts connected',
                subtitle: 'Click below to open GNOME Online Accounts and add one',
            });
            const btn = new Gtk.Button({label: 'Open GNOME Settings', css_classes: ['suggested-action', 'pill']});
            btn.connect('clicked', () => {
                Gio.Subprocess.new(['gnome-control-center', 'online-accounts'], 0);
            });
            empty.add_suffix(btn);
            group.add(empty);
        } else {
            for (const a of accounts) {
                const row = new Adw.SwitchRow({
                    title: a.email,
                    subtitle: `Calendar ${a.calendarDisabled ? 'off' : 'on'} · Tasks ${a.todoDisabled ? 'off' : 'on'}`,
                });
                row.set_active(enabled.length === 0 || enabled.includes(a.email));
                row.connect('notify::active', () => {
                    const cur = new Set(settings.get_strv('calendar-enabled-sources'));
                    if (row.get_active()) cur.add(a.email);
                    else                  cur.delete(a.email);
                    /* empty = all (legacy). if user disables some, emit explicit list */
                    if (cur.size === accounts.length) settings.set_strv('calendar-enabled-sources', []);
                    else settings.set_strv('calendar-enabled-sources', Array.from(cur));
                });
                group.add(row);
            }
            const manageBtn = new Adw.ActionRow({title: 'Manage accounts'});
            const open = new Gtk.Button({label: 'GNOME Settings', css_classes: ['pill']});
            open.connect('clicked', () => {
                Gio.Subprocess.new(['gnome-control-center', 'online-accounts'], 0);
            });
            manageBtn.add_suffix(open);
            group.add(manageBtn);
        }

        page.add(group);

        const tasksGroup = new Adw.PreferencesGroup({
            title: 'Google Tasks lists',
            description: 'Comma-separated list of task-list names to include. Empty shows all.',
        });
        const tasksEntry = new Adw.EntryRow({title: 'Allowed lists (comma-separated)'});
        tasksEntry.set_text(settings.get_strv('tasks-enabled-lists').join(', '));
        tasksEntry.connect('changed', () => {
            const raw = tasksEntry.get_text() ?? '';
            const arr = raw.split(',').map(s => s.trim()).filter(Boolean);
            settings.set_strv('tasks-enabled-lists', arr);
        });
        tasksGroup.add(tasksEntry);
        page.add(tasksGroup);

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
