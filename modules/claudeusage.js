import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';

/* Reads the local Claude Code CLI's own OAuth token (the same one the
   `claude` binary already holds) and asks Anthropic's usage endpoint how
   much of the current session/weekly quota has been used. This is the
   same undocumented-but-first-party endpoint the `claude` CLI itself
   queries — no credentials are read from or sent to anywhere other than
   api.anthropic.com, and nothing is written back. If the CLI has never
   logged in (or the token can't be refreshed), we just show "unavailable"
   rather than trying to perform an OAuth flow ourselves. */
const CREDENTIALS_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

export const ClaudeUsage = GObject.registerClass({
    Signals: {
        'updated': {},
    },
}, class ClaudeUsage extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._soup = new Soup.Session();
        this._soup.set_timeout(10);
        this._data = null;
        this._lastError = null;
        this._timer = 0;
        this._cancellable = new Gio.Cancellable();
    }

    start() {
        this._fetch();
        this._restartTimer();
        this._settingsSig = this._settings.connect('changed::claude-usage-refresh', () => this._restartTimer());
    }

    _restartTimer() {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = 0; }
        const minutes = Math.max(1, this._settings.get_int('claude-usage-refresh'));
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, minutes * 60, () => {
            this._fetch();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._cancellable) { try { this._cancellable.cancel(); } catch (_) {} }
        this._cancellable = new Gio.Cancellable();
        if (this._timer) { GLib.source_remove(this._timer); this._timer = 0; }
        if (this._settingsSig) { this._settings.disconnect(this._settingsSig); this._settingsSig = 0; }
    }

    destroy() { this.stop(); }

    _readToken() {
        try {
            const [ok, bytes] = GLib.file_get_contents(CREDENTIALS_PATH);
            if (!ok) return null;
            const json = JSON.parse(new TextDecoder().decode(bytes));
            return json?.claudeAiOauth?.accessToken ?? null;
        } catch (_) {
            return null;
        }
    }

    _fetch() {
        const token = this._readToken();
        if (!token) {
            this._lastError = 'No Claude Code login found (run `claude` once to sign in)';
            this.emit('updated');
            return;
        }
        const msg = Soup.Message.new('GET', USAGE_URL);
        msg.request_headers.append('Authorization', `Bearer ${token}`);
        msg.request_headers.append('anthropic-version', '2023-06-01');
        this._soup.send_and_read_async(msg, GLib.PRIORITY_LOW, this._cancellable, (session, res) => {
            if (this._cancellable?.is_cancelled()) return;
            try {
                const bytes = session.send_and_read_finish(res);
                const text = new TextDecoder().decode(bytes.get_data());
                if (msg.status_code < 200 || msg.status_code >= 300) {
                    this._lastError = `Usage check failed (${msg.status_code}) — try running \`claude\` to refresh your session`;
                    this.emit('updated');
                    return;
                }
                this._data = JSON.parse(text);
                this._lastError = null;
                this.emit('updated');
            } catch (e) {
                this._lastError = String(e?.message ?? e);
                logError(e, 'nexnotch:claudeusage');
                this.emit('updated');
            }
        });
    }

    render() {
        const box = new St.BoxLayout({style_class: 'nexnotch-claude', vertical: true, x_expand: true, y_expand: true});

        if (this._lastError && !this._data) {
            box.add_child(new St.Label({
                text: 'Claude usage unavailable', style_class: 'nexnotch-empty', x_align: Clutter.ActorAlign.CENTER,
            }));
            box.add_child(new St.Label({
                text: this._lastError, style_class: 'nexnotch-empty', x_align: Clutter.ActorAlign.CENTER,
            }));
            box.add_child(this._refreshRow());
            return box;
        }
        if (!this._data) {
            box.add_child(new St.Label({
                text: 'Loading Claude usage…', style_class: 'nexnotch-empty', x_align: Clutter.ActorAlign.CENTER,
            }));
            return box;
        }

        const rings = new St.BoxLayout({style_class: 'nexnotch-claude-rings', x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        const fiveHour = this._data.five_hour;
        const sevenDay = this._data.seven_day;
        if (fiveHour) rings.add_child(this._ring('Session (5h)', fiveHour.utilization, fiveHour.resets_at));
        if (sevenDay) rings.add_child(this._ring('Weekly', sevenDay.utilization, sevenDay.resets_at));
        box.add_child(rings);
        box.add_child(this._refreshRow());

        return box;
    }

    _refreshRow() {
        const row = new St.BoxLayout({style_class: 'nexnotch-claude-refresh-row', x_expand: true});
        const minutes = Math.max(1, this._settings.get_int('claude-usage-refresh'));
        row.add_child(new St.Label({
            text: `Auto-refreshes every ${minutes} min`,
            style_class: 'nexnotch-claude-refresh-label',
            x_expand: true,
        }));
        const btn = new St.Button({style_class: 'nexnotch-claude-refresh-btn', label: '↻ Refresh', can_focus: true});
        btn.connect('clicked', () => { btn.label = 'Refreshing…'; this._fetch(); });
        row.add_child(btn);
        return row;
    }

    _ring(label, pct, resetsAt) {
        pct = Math.max(0, Math.min(100, pct ?? 0));
        const col = new St.BoxLayout({style_class: 'nexnotch-claude-ringcol', vertical: true, x_align: Clutter.ActorAlign.CENTER});

        const SIZE = 72;
        const wrap = new St.Widget({layout_manager: new Clutter.BinLayout(), width: SIZE, height: SIZE});
        const area = new St.DrawingArea({style_class: 'nexnotch-claude-ring', width: SIZE, height: SIZE});
        area.connect('repaint', () => this._paintRing(area, pct, SIZE));
        wrap.add_child(area);

        const pctClass = pct > 90 ? 'danger' : (pct > 70 ? 'warn' : null);
        const pctLabel = new St.Label({
            text: `${pct.toFixed(0)}%`,
            style_class: 'nexnotch-claude-ring-pct',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (pctClass) pctLabel.add_style_class_name(pctClass);
        wrap.add_child(pctLabel);

        col.add_child(wrap);
        col.add_child(new St.Label({text: label, style_class: 'nexnotch-claude-label', x_align: Clutter.ActorAlign.CENTER}));

        if (resetsAt) {
            try {
                const d = new Date(resetsAt);
                col.add_child(new St.Label({
                    text: `Resets ${d.toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'})}`,
                    style_class: 'nexnotch-claude-reset',
                    x_align: Clutter.ActorAlign.CENTER,
                }));
            } catch (_) {}
        }

        return col;
    }

    _paintRing(area, pct, size) {
        const cr = area.get_context();
        const thick = 6;
        const cx = size / 2, cy = size / 2, r = size / 2 - thick / 2;

        cr.setLineWidth(thick);
        try { cr.setLineCap(1); } catch (_) {} // 1 = Cairo.LineCap.ROUND

        /* track */
        cr.setSourceRGBA(1, 1, 1, 0.12);
        cr.arc(cx, cy, r, 0, 2 * Math.PI);
        cr.stroke();

        /* fill arc, starting at 12 o'clock, clockwise */
        const frac = pct / 100;
        if (frac > 0) {
            let color;
            if (pct > 90)      color = [1, 0.4, 0.35];
            else if (pct > 70) color = [1, 0.75, 0.31];
            else               color = [0.47, 0.67, 1];
            cr.setSourceRGBA(color[0], color[1], color[2], 0.95);
            const start = -Math.PI / 2;
            cr.arc(cx, cy, r, start, start + frac * 2 * Math.PI);
            cr.stroke();
        }

        cr.$dispose();
    }
});
