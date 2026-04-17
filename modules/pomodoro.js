import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const LOG_DIR  = GLib.build_filenamev([GLib.get_user_data_dir(), 'mertnotch']);
const LOG_FILE = GLib.build_filenamev([LOG_DIR, 'pomodoro.jsonl']);

function _appendSession(entry) {
    try {
        GLib.mkdir_with_parents(LOG_DIR, 0o755);
        const line = JSON.stringify(entry) + '\n';
        const file = Gio.File.new_for_path(LOG_FILE);
        const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
        stream.write_all(line, null);
        stream.close(null);
    } catch (e) { logError(e, 'mertnotch:pomodoro:log'); }
}

export function readSessions() {
    try {
        const [ok, bytes] = GLib.file_get_contents(LOG_FILE);
        if (!ok) return [];
        const text = new TextDecoder().decode(bytes);
        return text.split('\n').filter(Boolean).map(l => {
            try { return JSON.parse(l); } catch (_) { return null; }
        }).filter(Boolean);
    } catch (_) { return []; }
}

export const Pomodoro = GObject.registerClass({
    Signals: {
        'tick':  {},
        'state': {param_types: [GObject.TYPE_STRING]},
    },
}, class Pomodoro extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._state  = 'idle';       // idle | work | break | longbreak | paused
        this._prev   = null;
        this._remain = 0;
        this._cycle  = 0;
        this._timer  = 0;
    }

    start() {}
    stop() { if (this._timer) { GLib.source_remove(this._timer); this._timer = 0; } }
    destroy() { this.stop(); }

    _activePreset() {
        const s = this._settings.get_string('pomodoro-active-preset') || '25/5';
        const m = s.match(/^(\d+)\s*\/\s*(\d+)/);
        if (!m) return {work: 25, brk: 5};
        return {work: Number(m[1]), brk: Number(m[2])};
    }

    startWork() {
        const {work} = this._activePreset();
        this._state  = 'work';
        this._remain = work * 60;
        this._cycle++;
        this._run();
    }

    startBreak() {
        const cycles = this._settings.get_int('pomodoro-cycles');
        const isLong = this._cycle > 0 && this._cycle % cycles === 0;
        const {brk} = this._activePreset();
        this._state  = isLong ? 'longbreak' : 'break';
        this._remain = isLong
            ? this._settings.get_int('pomodoro-long') * 60
            : brk * 60;
        this._run();
    }

    pause() {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = 0; }
        this._prev  = this._state;
        this._state = 'paused';
        this.emit('state', this._state);
    }

    resume() {
        if (this._prev) { this._state = this._prev; this._prev = null; this._run(); }
    }

    reset() {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = 0; }
        /* Log the aborted session with completed=false so the dashboard can
           distinguish finished from skipped pomodoros. */
        if (this._startedAt && (this._state === 'work' || this._state === 'break' || this._state === 'longbreak')) {
            this._logCompleted(false);
        }
        this._state  = 'idle';
        this._remain = 0;
        this._cycle  = 0;
        this._startedAt = null;
        this.emit('state', this._state);
    }

    _run() {
        this._startedAt = new Date();
        this.emit('state', this._state);
        this.emit('tick');
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 1, () => {
            this._remain--;
            if (this._remain <= 0) {
                this._timer = 0;
                this._onComplete();
                return GLib.SOURCE_REMOVE;
            }
            this.emit('tick');
            return GLib.SOURCE_CONTINUE;
        });
    }

    _onComplete() {
        const wasWork = this._state === 'work';
        this._logCompleted(true);
        this._notify(wasWork ? 'Work cycle complete' : 'Break over',
                     wasWork ? 'Time for a break!' : 'Back to work.');
        if (wasWork) this.startBreak();
        else         this.startWork();
    }

    _logCompleted(completed) {
        if (!this._startedAt) return;
        const {work, brk} = this._activePreset();
        const plannedSec = (this._state === 'work') ? work * 60 : brk * 60;
        const endedAt = new Date();
        _appendSession({
            started_at: this._startedAt.toISOString(),
            ended_at:   endedAt.toISOString(),
            kind:       this._state,
            preset:     this._settings.get_string('pomodoro-active-preset'),
            duration_sec: Math.round((endedAt - this._startedAt) / 1000),
            planned_sec:  plannedSec,
            completed,
        });
    }

    _notify(title, body) {
        try {
            const source = MessageTray.getSystemSource?.() ?? Main.messageTray.getSources()?.[0];
            const notif = new MessageTray.Notification({
                source, title, body,
                isTransient: true,
            });
            source.addNotification(notif);
        } catch (_) {
            try {
                Gio.Subprocess.new(['notify-send', '-u', 'normal', title, body],
                    Gio.SubprocessFlags.STDERR_SILENCE);
            } catch (e) { logError(e, 'mertnotch:pomodoro:notify'); }
        }
    }

    isActive() { return this._state !== 'idle' && this._state !== 'paused'; }
    getState() { return this._state; }
    getRemain() { return this._remain; }

    formatRemain() {
        const m = Math.floor(this._remain / 60);
        const s = this._remain % 60;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    render() {
        const box = new St.BoxLayout({style_class: 'mertnotch-pomo', vertical: true, x_expand: true, y_expand: true});

        /* preset selector */
        const presets = this._settings.get_strv('pomodoro-presets');
        const activePreset = this._settings.get_string('pomodoro-active-preset');
        const presetRow = new St.BoxLayout({style_class: 'mertnotch-pomo-presets', x_align: Clutter.ActorAlign.CENTER});
        for (const p of presets) {
            const btn = new St.Button({
                style_class: 'mertnotch-pomo-preset' + (p === activePreset ? ' active' : ''),
                label: p,
            });
            btn.connect('clicked', () => {
                this._settings.set_string('pomodoro-active-preset', p);
                if (this._state !== 'idle') this.reset();
                this.emit('state', this._state);
            });
            presetRow.add_child(btn);
        }
        box.add_child(presetRow);

        const big = new St.Label({
            text: this._state === 'idle' ? '—:—' : this.formatRemain(),
            style_class: 'mertnotch-pomo-big',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(big);

        const stateLabel = new St.Label({
            text: this._stateLabel(),
            style_class: 'mertnotch-pomo-state',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(stateLabel);

        const {work, brk} = this._activePreset();
        const cyclesLabel = new St.Label({
            text: `Cycle ${this._cycle} · ${work}/${brk}min`,
            style_class: 'mertnotch-pomo-cycles',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(cyclesLabel);

        const btns = new St.BoxLayout({style_class: 'mertnotch-pomo-btns', x_align: Clutter.ActorAlign.CENTER});
        const startBtn = new St.Button({
            style_class: 'mertnotch-pomo-btn primary',
            label: this._state === 'idle' ? 'Start' : (this._state === 'paused' ? 'Resume' : 'Pause'),
        });
        startBtn.connect('clicked', () => {
            if (this._state === 'idle')   this.startWork();
            else if (this._state === 'paused') this.resume();
            else this.pause();
        });
        const resetBtn = new St.Button({style_class: 'mertnotch-pomo-btn', label: 'Reset'});
        resetBtn.connect('clicked', () => this.reset());
        btns.add_child(startBtn);
        btns.add_child(resetBtn);
        box.add_child(btns);

        return box;
    }

    _stateLabel() {
        return {
            idle:      'Ready',
            work:      'Focus',
            break:     'Short break',
            longbreak: 'Long break',
            paused:    'Paused',
        }[this._state] ?? this._state;
    }
});
