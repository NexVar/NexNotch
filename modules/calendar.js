import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

const CALENDAR_SERVER_XML = `
<node>
  <interface name="org.gnome.Shell.CalendarServer">
    <method name="SetTimeRange">
      <arg type="x" direction="in" name="since"/>
      <arg type="x" direction="in" name="until"/>
      <arg type="b" direction="in" name="force_reload"/>
    </method>
    <signal name="EventsAddedOrUpdated">
      <arg type="a(ssbxx)" name="events"/>
    </signal>
    <signal name="EventsRemoved">
      <arg type="as" name="ids"/>
    </signal>
    <signal name="ClientDisappeared">
      <arg type="s" name="source_uid"/>
    </signal>
    <property name="Events" type="a(ssbxx)" access="read"/>
    <property name="HasCalendars" type="b" access="read"/>
  </interface>
</node>`;

const CalendarProxy = Gio.DBusProxy.makeProxyWrapper(CALENDAR_SERVER_XML);

let _ECal = null;
let _EDataServer = null;
try {
    _ECal = (await import('gi://ECal?version=2.0')).default;
    _EDataServer = (await import('gi://EDataServer?version=1.2')).default;
} catch (e) {
    log('mertnotch: libecal GIR not available, tasks disabled');
}

export const CalendarPeek = GObject.registerClass({
    Signals: {
        'updated': {},
    },
}, class CalendarPeek extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._events = [];
        this._tasks  = [];
        this._proxy  = null;
        this._sigIds = [];
        this._refreshTimer = 0;
        this._tasksTimer = 0;
        this._taskClients = [];
    }

    start() {
        this._startCalendar();
        this._startTasks();
    }

    stop() {
        if (this._refreshTimer) { GLib.source_remove(this._refreshTimer); this._refreshTimer = 0; }
        if (this._tasksTimer)   { GLib.source_remove(this._tasksTimer);   this._tasksTimer = 0; }
        if (this._proxy) {
            for (const [_, id] of this._sigIds) {
                try { this._proxy.disconnectSignal(id); } catch (_) {}
            }
            this._sigIds = [];
            this._proxy = null;
        }
        this._taskClients = [];
    }

    destroy() { this.stop(); }

    _startCalendar() {
        try {
            this._proxy = CalendarProxy(
                Gio.DBus.session,
                'org.gnome.Shell.CalendarServer',
                '/org/gnome/Shell/CalendarServer'
            );
            this._sigIds.push(['ev+', this._proxy.connectSignal('EventsAddedOrUpdated', (_p, _s, [t]) => this._onEventsAdded(t))]);
            this._sigIds.push(['ev-', this._proxy.connectSignal('EventsRemoved',       (_p, _s, [i]) => this._onEventsRemoved(i))]);
            this._refreshRange();
            this._refreshTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 300, () => {
                this._refreshRange();
                return GLib.SOURCE_CONTINUE;
            });
        } catch (e) { logError(e, 'mertnotch:calendar'); }
    }

    _refreshRange() {
        if (!this._proxy) return;
        const now = Math.floor(Date.now() / 1000);
        const until = now + 14 * 24 * 3600;
        try { this._proxy.SetTimeRangeRemote(now, until, false, () => {}); } catch (e) { logError(e); }
    }

    _onEventsAdded(tuples) {
        for (const [id, summary, allDay, start, end] of tuples) {
            const existing = this._events.findIndex(e => e.id === id);
            const ev = {id, summary, allDay, start, end};
            if (existing >= 0) this._events[existing] = ev;
            else this._events.push(ev);
        }
        this._events.sort((a, b) => a.start - b.start);
        this.emit('updated');
    }

    _onEventsRemoved(ids) {
        this._events = this._events.filter(e => !ids.includes(e.id));
        this.emit('updated');
    }

    _startTasks() {
        if (!_ECal || !_EDataServer) return;
        try {
            const registry = _EDataServer.SourceRegistry.new_sync(null);
            const sources = registry.list_sources(_EDataServer.SOURCE_EXTENSION_TASK_LIST);
            for (const src of sources) {
                if (!src.get_enabled()) continue;
                _ECal.Client.connect(src, _ECal.ClientSourceType.TASKS, 30, null,
                    (_, res) => this._onTaskClient(src, res));
            }
            this._tasksTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 600, () => {
                this._refreshAllTasks();
                return GLib.SOURCE_CONTINUE;
            });
        } catch (e) { logError(e, 'mertnotch:tasks:start'); }
    }

    _onTaskClient(source, res) {
        try {
            const client = _ECal.Client.connect_finish(res);
            this._taskClients.push({source, client});
            this._refreshTaskClient(source, client);
        } catch (e) { logError(e, 'mertnotch:tasks:connect'); }
    }

    _refreshAllTasks() {
        this._tasks = [];
        for (const {source, client} of this._taskClients) this._refreshTaskClient(source, client);
    }

    _refreshTaskClient(source, client) {
        try {
            client.get_object_list(
                '(and (not is-completed?) (not (contains? "any" "")))',
                null,
                (_, res) => {
                    try {
                        const [, objs] = client.get_object_list_finish(res);
                        const listName = source.get_display_name();
                        for (const icalComp of objs) {
                            const summary  = icalComp.get_summary();
                            const status   = icalComp.get_status();
                            const dueProp  = icalComp.get_due();
                            const due = dueProp && !dueProp.is_null_time()
                                ? new Date(dueProp.get_value().as_timet() * 1000)
                                : null;
                            this._tasks.push({
                                id: icalComp.get_uid(),
                                title: summary ?? '(untitled)',
                                done: status === 'COMPLETED',
                                due,
                                list: listName,
                            });
                        }
                        this._tasks.sort((a, b) => (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity));
                        this.emit('updated');
                    } catch (e) { logError(e, 'mertnotch:tasks:list'); }
                });
        } catch (e) { logError(e, 'mertnotch:tasks:refresh'); }
    }

    render(tab) {
        if (tab === 'tasks') return this._renderTasks();
        return this._renderCalendar();
    }

    _renderCalendar() {
        const box = new St.BoxLayout({style_class: 'mertnotch-cal', vertical: true, x_expand: true, y_expand: true});
        if (this._events.length === 0) {
            box.add_child(new St.Label({
                text: 'No upcoming events',
                style_class: 'mertnotch-empty',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return box;
        }
        for (const ev of this._events.slice(0, 7)) {
            const row = new St.BoxLayout({style_class: 'mertnotch-cal-row'});
            row.add_child(new St.Label({text: this._formatTime(ev), style_class: 'mertnotch-cal-when'}));
            row.add_child(new St.Label({text: ev.summary, style_class: 'mertnotch-cal-title', x_expand: true}));
            box.add_child(row);
        }
        return box;
    }

    _renderTasks() {
        const box = new St.BoxLayout({style_class: 'mertnotch-tasks', vertical: true, x_expand: true, y_expand: true});
        if (!_ECal) {
            box.add_child(new St.Label({
                text: 'libecal unavailable — install evolution-data-server',
                style_class: 'mertnotch-empty',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return box;
        }
        if (this._tasks.length === 0) {
            box.add_child(new St.Label({
                text: 'No pending tasks',
                style_class: 'mertnotch-empty',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return box;
        }
        for (const t of this._tasks.slice(0, 9)) {
            const row = new St.BoxLayout({style_class: 'mertnotch-task-row'});
            row.add_child(new St.Label({text: t.done ? '☑' : '☐', style_class: 'mertnotch-task-check'}));
            row.add_child(new St.Label({text: t.title, x_expand: true}));
            if (t.due) row.add_child(new St.Label({text: this._formatDue(t.due), style_class: 'mertnotch-task-due'}));
            box.add_child(row);
        }
        return box;
    }

    _formatTime(ev) {
        const d = new Date(ev.start * 1000);
        const now = new Date();
        const sameDay = (a, b) => a.toDateString() === b.toDateString();
        const tomorrow = new Date(now.getTime() + 86400000);
        const time = ev.allDay ? '—' : d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
        if (sameDay(d, now))      return `Today ${time}`;
        if (sameDay(d, tomorrow)) return `Tom ${time}`;
        return d.toLocaleDateString([], {weekday: 'short', day: 'numeric'}) + (ev.allDay ? '' : ` ${time}`);
    }

    _formatDue(d) {
        const now = new Date();
        const dayMs = 86400000;
        const diff  = Math.floor((d.getTime() - now.getTime()) / dayMs);
        if (diff < 0)  return `${-diff}d late`;
        if (diff === 0) return 'today';
        if (diff === 1) return 'tom';
        if (diff < 7)  return `${diff}d`;
        return d.toLocaleDateString([], {day: 'numeric', month: 'short'});
    }
});
