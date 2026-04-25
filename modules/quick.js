import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

const UPOWER_XML = `
<node>
  <interface name="org.freedesktop.DBus.ObjectManager">
    <method name="GetManagedObjects">
      <arg type="a{oa{sa{sv}}}" direction="out"/>
    </method>
  </interface>
</node>`;

export const QuickHub = GObject.registerClass({
    Signals: {
        'updated': {},
    },
}, class QuickHub extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._mic = false;
        this._cam = false;
        this._btDevices = [];
        this._kbLayout = '';
        this._poller = 0;
        this._armedTimers = new Set();
        try {
            this._dndSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        } catch (_) { this._dndSettings = null; }
    }

    start() {
        this._stopped = false;
        this._refresh();
        /* 15 s is enough for privacy/BT status — 4 subprocess spawns per
           refresh × 12/min was too aggressive. */
        this._poller = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 15, () => {
            if (this._stopped) return GLib.SOURCE_REMOVE;
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        this._stopped = true;
        if (this._poller) { GLib.source_remove(this._poller); this._poller = 0; }
        for (const id of this._armedTimers) {
            try { GLib.source_remove(id); } catch (_) {}
        }
        this._armedTimers.clear();
    }

    destroy() { this.stop(); }

    async _refresh() {
        try {
            this._mic = await this._anyAppUsing('Audio/Source');
            this._cam = await this._anyCameraUsing();
            this._btDevices = await this._btBatteries();
            this._kbLayout  = this._currentLayout();
            this.emit('updated');
        } catch (e) { logError(e, 'nexnotch:quick:refresh'); }
    }

    async _anyAppUsing(_role) {
        return await new Promise(resolve => {
            if (!GLib.find_program_in_path('pactl')) { resolve(false); return; }
            try {
                const proc = Gio.Subprocess.new(
                    ['pactl', '-f', 'json', 'list', 'source-outputs'],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
                );
                proc.communicate_utf8_async(null, null, (p, res) => {
                    try {
                        const [, out] = p.communicate_utf8_finish(res);
                        const data = JSON.parse(out || '[]');
                        resolve(Array.isArray(data) && data.length > 0);
                    } catch (_) { resolve(false); }
                });
            } catch (_) { resolve(false); }
        });
    }

    async _anyCameraUsing() {
        /* Avoid `sh -c` entirely — enumerate /dev/video* ourselves and spawn
           fuser directly with an explicit absolute path. Portable and the
           spawn matches the guarded binary. */
        const fuserPath = GLib.find_program_in_path('fuser');
        if (!fuserPath) return false;
        const devs = [];
        try {
            const dir = Gio.File.new_for_path('/dev');
            const iter = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = iter.next_file(null))) {
                const n = info.get_name();
                if (/^video\d+$/.test(n)) devs.push(`/dev/${n}`);
            }
        } catch (_) { return false; }
        if (devs.length === 0) return false;
        return new Promise(resolve => {
            try {
                const proc = Gio.Subprocess.new(
                    [fuserPath, ...devs],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
                );
                proc.communicate_utf8_async(null, null, (p, res) => {
                    try {
                        const [, out] = p.communicate_utf8_finish(res);
                        resolve(out.trim().length > 0);
                    } catch (_) { resolve(false); }
                });
            } catch (_) { resolve(false); }
        });
    }

    async _btBatteries() {
        return await new Promise(resolve => {
            if (!GLib.find_program_in_path('upower')) { resolve([]); return; }
            try {
                const proc = Gio.Subprocess.new(
                    ['upower', '-d'],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
                );
                proc.communicate_utf8_async(null, null, (p, res) => {
                    try {
                        const [, out] = p.communicate_utf8_finish(res);
                        const devs = [];
                        const blocks = out.split(/\n\s*\n/);
                        for (const b of blocks) {
                            if (!/model:/i.test(b)) continue;
                            if (!/battery/i.test(b) && !/headset|headphones|keyboard|mouse|phone/i.test(b)) continue;
                            const model = (b.match(/model:\s+([^\n]+)/) || [])[1];
                            const pctRaw = (b.match(/percentage:\s+(\d+)/) || [])[1];
                            const pct   = Number(pctRaw);
                            /* keep 0% devices — they're the ones that need alerting */
                            if (model && Number.isFinite(pct)) devs.push({model: model.trim(), pct});
                        }
                        resolve(devs);
                    } catch (_) { resolve([]); }
                });
            } catch (_) { resolve([]); }
        });
    }

    _currentLayout() {
        try {
            const src = new Gio.Settings({schema_id: 'org.gnome.desktop.input-sources'});
            const srcs = src.get_value('sources').deep_unpack();
            const cur  = src.get_uint('current');
            if (srcs[cur]) return srcs[cur][1];
        } catch (_) {}
        return '';
    }

    render() {
        const box = new St.BoxLayout({style_class: 'nexnotch-quick', vertical: true, x_expand: true, y_expand: true});

        const privacyRow = new St.BoxLayout({style_class: 'nexnotch-quick-row'});
        privacyRow.add_child(this._pill('Mic',    this._mic  ? 'on'  : 'off', this._mic));
        privacyRow.add_child(this._pill('Camera', this._cam  ? 'on'  : 'off', this._cam));
        privacyRow.add_child(this._pill('Layout', this._kbLayout || '—', false));
        box.add_child(privacyRow);

        if (this._btDevices.length > 0) {
            box.add_child(new St.Label({text: 'Bluetooth', style_class: 'nexnotch-quick-section'}));
            for (const d of this._btDevices) {
                const r = new St.BoxLayout({style_class: 'nexnotch-quick-bt-row'});
                r.add_child(new St.Label({text: d.model, style_class: 'nexnotch-quick-bt-name', x_expand: true}));
                const pctLbl = new St.Label({text: `${d.pct}%`, style_class: 'nexnotch-quick-bt-pct'});
                if (d.pct < 20) pctLbl.add_style_class_name('low');
                r.add_child(pctLbl);
                box.add_child(r);
            }
        }

        box.add_child(new St.Label({text: 'Focus', style_class: 'nexnotch-quick-section'}));
        const focusRow = new St.BoxLayout({style_class: 'nexnotch-quick-actions'});
        const dndOn = this._dndSettings ? !this._dndSettings.get_boolean('show-banners') : false;
        const dndBtn = new St.Button({
            style_class: 'nexnotch-quick-action' + (dndOn ? ' active' : ''),
            label: dndOn ? 'DND: On' : 'DND: Off',
        });
        dndBtn.connect('clicked', () => {
            if (!this._dndSettings) return;
            const cur = this._dndSettings.get_boolean('show-banners');
            this._dndSettings.set_boolean('show-banners', !cur);
            dndBtn.label = cur ? 'DND: On' : 'DND: Off';
            dndBtn.remove_style_class_name('active');
            if (cur) dndBtn.add_style_class_name('active');
        });
        focusRow.add_child(dndBtn);
        box.add_child(focusRow);

        box.add_child(new St.Label({text: 'System', style_class: 'nexnotch-quick-section'}));
        const actions = new St.BoxLayout({style_class: 'nexnotch-quick-actions'});
        /* Lock and Suspend are safe one-click; Log out / Reboot / Shutdown
           require a second confirmation click within 3 s ("Really?" arm
           state) so accidental taps in a tiny hover panel don't kill work. */
        actions.add_child(this._actionButton('Lock',      () => this._run(['loginctl', 'lock-session'])));
        actions.add_child(this._actionButton('Suspend',   () => this._run(['systemctl', 'suspend'])));
        actions.add_child(this._armedActionButton('Log out',  ['gnome-session-quit', '--logout', '--no-prompt']));
        actions.add_child(this._armedActionButton('Reboot',   ['systemctl', 'reboot']));
        actions.add_child(this._armedActionButton('Shutdown', ['systemctl', 'poweroff']));
        box.add_child(actions);

        return box;
    }

    _pill(label, value, active) {
        const p = new St.BoxLayout({style_class: 'nexnotch-quick-pill' + (active ? ' active' : '')});
        p.add_child(new St.Label({text: label, style_class: 'nexnotch-quick-pill-label'}));
        p.add_child(new St.Label({text: value, style_class: 'nexnotch-quick-pill-value'}));
        return p;
    }

    _actionButton(label, cb) {
        const b = new St.Button({style_class: 'nexnotch-quick-action', label, accessible_name: label, can_focus: true});
        b.connect('clicked', cb);
        return b;
    }

    _armedActionButton(label, argv) {
        const b = new St.Button({
            style_class: 'nexnotch-quick-action',
            label,
            accessible_name: `${label} (click twice to confirm)`,
            can_focus: true,
        });
        let armed = false;
        let armTimer = 0;
        const disarm = () => {
            armed = false;
            if (armTimer) {
                this._armedTimers.delete(armTimer);
                try { GLib.source_remove(armTimer); } catch (_) {}
                armTimer = 0;
            }
            try { b.label = label; b.remove_style_class_name('armed'); } catch (_) {}
        };
        b.connect('clicked', () => {
            if (this._stopped) return;
            if (armed) { disarm(); this._run(argv); return; }
            armed = true;
            b.label = 'Really?';
            b.add_style_class_name('armed');
            if (armTimer) { this._armedTimers.delete(armTimer); GLib.source_remove(armTimer); }
            armTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                this._armedTimers.delete(armTimer);
                armTimer = 0;
                disarm();
                return GLib.SOURCE_REMOVE;
            });
            this._armedTimers.add(armTimer);
        });
        /* if the whole tab rerenders while armed, the button is destroyed —
           make sure we also drop the pending timer rather than touching a
           dead actor. */
        b.connect('destroy', () => disarm());
        return b;
    }

    _run(argv) {
        if (!GLib.find_program_in_path(argv[0])) {
            logError(new Error(`${argv[0]} not in PATH`), 'nexnotch:quick:run');
            return;
        }
        try {
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) { logError(e, 'nexnotch:quick:run'); }
    }
});
