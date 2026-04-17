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
let _eImportAttempted = false;

async function _loadEdsBindings() {
    if (_eImportAttempted) return;
    _eImportAttempted = true;
    try {
        _ECal        = (await import('gi://ECal?version=2.0')).default;
        _EDataServer = (await import('gi://EDataServer?version=1.2')).default;
    } catch (e) {
        log('mertnotch: libecal GIR not available, tasks disabled');
    }
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
        _loadEdsBindings().then(() => this._startTasks());
    }

    stop() {
        this._stopped = true;
        if (this._refreshTimer) { GLib.source_remove(this._refreshTimer); this._refreshTimer = 0; }
        if (this._tasksTimer)   { GLib.source_remove(this._tasksTimer);   this._tasksTimer = 0; }
        if (this._filterSig1) { this._settings.disconnect(this._filterSig1); this._filterSig1 = 0; }
        if (this._filterSig2) { this._settings.disconnect(this._filterSig2); this._filterSig2 = 0; }
        if (this._proxy) {
            for (const [_, id] of this._sigIds) {
                try { this._proxy.disconnectSignal(id); } catch (_) {}
            }
            this._sigIds = [];
            this._proxy = null;
        }
        this._taskClients = [];
        this._emailMap = null;
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
            /* Invalidate source->email map when a new GOA account is added or
               removed so filters don't reference stale UIDs. */
            this._filterSig1 = this._settings.connect('changed::calendar-enabled-sources', () => {
                this._emailMap = null;
                this.emit('updated');
            });
            this._filterSig2 = this._settings.connect('changed::tasks-enabled-lists', () => this.emit('updated'));
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

    _filterEvents(events) {
        const enabled = this._settings.get_strv('calendar-enabled-sources');
        if (enabled.length === 0) return events;
        /* Event IDs from Shell.CalendarServer are `SourceUID:EventUID`.
           We map SourceUID to GOA email via the EDS registry if available.
           Unknown sources are REJECTED when the filter is non-empty — fail
           closed so disabled accounts can't leak through. */
        try {
            const emailFor = this._sourceEmailMap();
            return events.filter(e => {
                const srcUid = (e.id ?? '').split(':')[0];
                const email = emailFor.get(srcUid);
                return !!email && enabled.includes(email);
            });
        } catch (_) { return []; }
    }

    _sourceEmailMap() {
        if (this._emailMap) return this._emailMap;
        this._emailMap = new Map();
        if (!_EDataServer) return this._emailMap;
        try {
            const registry = _EDataServer.SourceRegistry.new_sync(null);
            const all = registry.list_sources(null);
            for (const src of all) {
                const uid = src.get_uid();
                let parent = src;
                for (let i = 0; i < 8 && parent; i++) {
                    if (parent.has_extension?.('Authentication')) {
                        const auth = parent.get_extension('Authentication');
                        const user = auth?.get_user?.();
                        if (user?.includes('@')) { this._emailMap.set(uid, user); break; }
                    }
                    const parentUid = parent.get_parent?.();
                    parent = parentUid ? registry.ref_source(parentUid) : null;
                }
            }
        } catch (e) { logError(e, 'mertnotch:calendar:emailMap'); }
        return this._emailMap;
    }

    _onEventsRemoved(ids) {
        this._events = this._events.filter(e => !ids.includes(e.id));
        this.emit('updated');
    }

    _startTasks() {
        if (!_ECal || !_EDataServer) return;
        this._stopped = false;
        try {
            const registry = _EDataServer.SourceRegistry.new_sync(null);
            const sources = registry.list_sources(_EDataServer.SOURCE_EXTENSION_TASK_LIST);
            for (const src of sources) {
                if (!src.get_enabled()) continue;
                _ECal.Client.connect(src, _ECal.ClientSourceType.TASKS, 30, null,
                    (_, res) => this._onTaskClient(src, res));
            }
            this._tasksTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 600, () => {
                if (this._stopped) return GLib.SOURCE_REMOVE;
                this._refreshAllTasks();
                return GLib.SOURCE_CONTINUE;
            });
        } catch (e) { logError(e, 'mertnotch:tasks:start'); }
    }

    _onTaskClient(source, res) {
        if (this._stopped) return;
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
        if (this._stopped) return;
        try {
            client.get_object_list(
                '(not (is-completed?))',
                null,
                (_, res) => {
                    if (this._stopped) return;
                    try {
                        const finish = client.get_object_list_finish(res);
                        const objs = Array.isArray(finish) && finish.length === 2 ? finish[1] : finish;
                        if (!objs) return;
                        const listName = source.get_display_name?.() ?? '';
                        for (const icalComp of objs) {
                            try {
                                const summary  = icalComp.get_summary?.();
                                const status   = icalComp.get_status?.();
                                const dueProp  = icalComp.get_due?.();
                                const due = dueProp && !dueProp.is_null_time?.()
                                    ? new Date(dueProp.get_value().as_timet() * 1000)
                                    : null;
                                this._tasks.push({
                                    id: icalComp.get_uid?.(),
                                    title: summary ?? '(untitled)',
                                    done: status === 'COMPLETED',
                                    due,
                                    list: listName,
                                });
                            } catch (_) {}
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
        const events = this._filterEvents(this._events);
        if (events.length === 0) {
            box.add_child(new St.Label({
                text: 'No upcoming events',
                style_class: 'mertnotch-empty',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return box;
        }
        for (const ev of events.slice(0, 7)) {
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

        const filter = this._settings.get_strv('tasks-enabled-lists');
        let tasks = this._tasks;
        if (filter.length > 0) tasks = tasks.filter(t => filter.includes(t.list));

        /* group by list */
        const byList = new Map();
        for (const t of tasks) {
            const key = t.list || '(Default)';
            if (!byList.has(key)) byList.set(key, []);
            byList.get(key).push(t);
        }
        const lists = Array.from(byList.keys()).sort();

        if (lists.length === 0) {
            box.add_child(new St.Label({
                text: 'No pending tasks',
                style_class: 'mertnotch-empty',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return box;
        }

        /* if more than one list, show segmented tab bar */
        if (lists.length > 1) {
            if (!lists.includes(this._activeTaskList)) this._activeTaskList = lists[0];
            const listBar = new St.BoxLayout({style_class: 'mertnotch-task-lists', x_expand: true});
            for (const name of lists) {
                const active = name === this._activeTaskList;
                const count = byList.get(name).length;
                const btn = new St.Button({
                    style_class: 'mertnotch-task-list-tab' + (active ? ' active' : ''),
                    label: `${name} · ${count}`,
                    x_expand: true,
                });
                btn.connect('clicked', () => { this._activeTaskList = name; this.emit('updated'); });
                listBar.add_child(btn);
            }
            box.add_child(listBar);

            const items = byList.get(this._activeTaskList) ?? [];
            for (const t of items.slice(0, 8)) box.add_child(this._taskRow(t));
        } else {
            const items = byList.get(lists[0]) ?? [];
            for (const t of items.slice(0, 9)) box.add_child(this._taskRow(t));
        }
        return box;
    }

    _taskRow(t) {
        const row = new St.BoxLayout({style_class: 'mertnotch-task-row'});
        row.add_child(new St.Label({text: t.done ? '☑' : '☐', style_class: 'mertnotch-task-check'}));
        row.add_child(new St.Label({text: t.title, x_expand: true}));
        if (t.due) row.add_child(new St.Label({text: this._formatDue(t.due), style_class: 'mertnotch-task-due'}));
        return row;
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
