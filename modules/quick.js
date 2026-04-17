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
    }

    start() {
        this._refresh();
        this._poller = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 5, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._poller) { GLib.source_remove(this._poller); this._poller = 0; }
    }

    destroy() { this.stop(); }

    async _refresh() {
        try {
            this._mic = await this._anyAppUsing('Audio/Source');
            this._cam = await this._anyCameraUsing();
            this._btDevices = await this._btBatteries();
            this._kbLayout  = this._currentLayout();
            this.emit('updated');
        } catch (e) { logError(e, 'mertnotch:quick:refresh'); }
    }

    async _anyAppUsing(_role) {
        return await new Promise(resolve => {
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
        return await new Promise(resolve => {
            try {
                const proc = Gio.Subprocess.new(
                    ['sh', '-c', 'fuser /dev/video* 2>/dev/null | wc -w'],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
                );
                proc.communicate_utf8_async(null, null, (p, res) => {
                    try {
                        const [, out] = p.communicate_utf8_finish(res);
                        resolve(Number(out.trim()) > 0);
                    } catch (_) { resolve(false); }
                });
            } catch (_) { resolve(false); }
        });
    }

    async _btBatteries() {
        return await new Promise(resolve => {
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
                            const pct   = Number((b.match(/percentage:\s+(\d+)/) || [])[1]);
                            if (model && pct) devs.push({model: model.trim(), pct});
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
        const box = new St.BoxLayout({style_class: 'mertnotch-quick', vertical: true, x_expand: true, y_expand: true});

        const privacyRow = new St.BoxLayout({style_class: 'mertnotch-quick-row'});
        privacyRow.add_child(this._pill('Mic',    this._mic  ? 'on'  : 'off', this._mic));
        privacyRow.add_child(this._pill('Camera', this._cam  ? 'on'  : 'off', this._cam));
        privacyRow.add_child(this._pill('Layout', this._kbLayout || '—', false));
        box.add_child(privacyRow);

        if (this._btDevices.length > 0) {
            box.add_child(new St.Label({text: 'Bluetooth', style_class: 'mertnotch-quick-section'}));
            for (const d of this._btDevices) {
                const r = new St.BoxLayout({style_class: 'mertnotch-quick-bt-row'});
                r.add_child(new St.Label({text: d.model, style_class: 'mertnotch-quick-bt-name', x_expand: true}));
                const pctLbl = new St.Label({text: `${d.pct}%`, style_class: 'mertnotch-quick-bt-pct'});
                if (d.pct < 20) pctLbl.add_style_class_name('low');
                r.add_child(pctLbl);
                box.add_child(r);
            }
        }

        box.add_child(new St.Label({text: 'Actions', style_class: 'mertnotch-quick-section'}));
        const actions = new St.BoxLayout({style_class: 'mertnotch-quick-actions'});
        actions.add_child(this._actionButton('Lock',      () => this._run(['loginctl', 'lock-session'])));
        actions.add_child(this._actionButton('Suspend',   () => this._run(['systemctl', 'suspend'])));
        actions.add_child(this._actionButton('Log out',   () => this._run(['gnome-session-quit', '--logout', '--no-prompt'])));
        actions.add_child(this._actionButton('Reboot',    () => this._run(['systemctl', 'reboot'])));
        actions.add_child(this._actionButton('Shutdown',  () => this._run(['systemctl', 'poweroff'])));
        box.add_child(actions);

        return box;
    }

    _pill(label, value, active) {
        const p = new St.BoxLayout({style_class: 'mertnotch-quick-pill' + (active ? ' active' : '')});
        p.add_child(new St.Label({text: label, style_class: 'mertnotch-quick-pill-label'}));
        p.add_child(new St.Label({text: value, style_class: 'mertnotch-quick-pill-value'}));
        return p;
    }

    _actionButton(label, cb) {
        const b = new St.Button({style_class: 'mertnotch-quick-action', label});
        b.connect('clicked', cb);
        return b;
    }

    _run(argv) {
        try {
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) { logError(e, 'mertnotch:quick:run'); }
    }
});
