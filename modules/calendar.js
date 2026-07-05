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
      <arg type="a(ssxxa{sv})" name="events"/>
    </signal>
    <signal name="EventsRemoved">
      <arg type="as" name="ids"/>
    </signal>
    <signal name="ClientDisappeared">
      <arg type="s" name="source_uid"/>
    </signal>
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
        log('nexnotch: libecal GIR not available, tasks disabled');
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
        if (this._cancellable) { try { this._cancellable.cancel(); } catch (_) {} this._cancellable = null; }
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
        } catch (e) { logError(e, 'nexnotch:calendar'); }
    }

    _refreshRange() {
        if (!this._proxy) return;
        const now = Math.floor(Date.now() / 1000);
        const until = now + 14 * 24 * 3600;
        try { this._proxy.SetTimeRangeRemote(now, until, false, () => {}); } catch (e) { logError(e); }
    }

    _onEventsAdded(tuples) {
        for (const [id, summary, start, end, extras] of tuples) {
            /* GNOME's CalendarServer doesn't send an explicit all-day flag
               in `extras` in practice — derive it from the span instead.
               All-day events are aligned to local-midnight, not UTC
               midnight, so only the duration (exact multiple of a day) is
               a reliable signal here. */
            let allDay = !!(extras?.['all-day'] ?? extras?.allDay);
            if (!allDay) {
                const span = end - start;
                allDay = span > 0 && span % 86400 === 0;
            }
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
        /* Event IDs from Shell.CalendarServer are `SourceUID\nEventUID\n...`
           (newline-separated, not colon-separated). We map SourceUID to GOA
           email via the EDS registry if available. Unknown sources are
           REJECTED when the filter is non-empty — fail closed so disabled
           accounts can't leak through. */
        try {
            const emailFor = this._sourceEmailMap();
            return events.filter(e => {
                const srcUid = (e.id ?? '').split('\n')[0];
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
        } catch (e) { logError(e, 'nexnotch:calendar:emailMap'); }
        return this._emailMap;
    }

    _onEventsRemoved(ids) {
        this._events = this._events.filter(e => !ids.includes(e.id));
        this.emit('updated');
    }

    _startTasks() {
        if (!_ECal || !_EDataServer) return;
        this._stopped = false;
        this._cancellable = new Gio.Cancellable();
        try {
            const registry = _EDataServer.SourceRegistry.new_sync(this._cancellable);
            const sources = registry.list_sources(_EDataServer.SOURCE_EXTENSION_TASK_LIST);
            for (const src of sources) {
                if (!src.get_enabled()) continue;
                _ECal.Client.connect(src, _ECal.ClientSourceType.TASKS, 30, this._cancellable,
                    (_, res) => {
                        if (this._stopped || this._cancellable?.is_cancelled()) return;
                        this._onTaskClient(src, res);
                    });
            }
            this._tasksTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 600, () => {
                if (this._stopped) return GLib.SOURCE_REMOVE;
                this._refreshAllTasks();
                return GLib.SOURCE_CONTINUE;
            });
        } catch (e) { logError(e, 'nexnotch:tasks:start'); }
    }

    _onTaskClient(source, res) {
        if (this._stopped) return;
        try {
            const client = _ECal.Client.connect_finish(res);
            this._taskClients.push({source, client});
            this._refreshTaskClient(source, client);
        } catch (e) { logError(e, 'nexnotch:tasks:connect'); }
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
                this._cancellable,
                (_, res) => {
                    if (this._stopped || this._cancellable?.is_cancelled()) return;
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
                    } catch (e) { logError(e, 'nexnotch:tasks:list'); }
                });
        } catch (e) { logError(e, 'nexnotch:tasks:refresh'); }
    }

    render(tab) {
        if (tab === 'tasks') return this._renderTasks();
        return this._renderCalendar();
    }

    _renderCalendar() {
        const box = new St.BoxLayout({style_class: 'nexnotch-cal', vertical: true, x_expand: true, y_expand: true});
        box.add_child(this._monthGrid());

        const events = this._filterEvents(this._events).filter(ev => ev.end * 1000 >= Date.now());
        if (events.length === 0) {
            box.add_child(new St.Label({
                text: 'No upcoming events',
                style_class: 'nexnotch-empty',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return box;
        }

        const list = events.slice(0, 16);
        const half = Math.ceil(list.length / 2);
        const cols = new St.BoxLayout({style_class: 'nexnotch-cal-cols', x_expand: true});
        const left  = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'nexnotch-cal-col'});
        const right = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'nexnotch-cal-col'});
        list.slice(0, half).forEach(ev => left.add_child(this._eventRow(ev)));
        list.slice(half).forEach(ev => right.add_child(this._eventRow(ev)));
        cols.add_child(left);
        cols.add_child(right);
        box.add_child(cols);
        return box;
    }

    _eventRow(ev) {
        const row = new St.BoxLayout({style_class: 'nexnotch-cal-row'});
        row.add_child(new St.Label({text: this._formatTime(ev), style_class: 'nexnotch-cal-when'}));
        row.add_child(new St.Label({text: ev.summary, style_class: 'nexnotch-cal-title', x_expand: true}));
        return row;
    }

    _monthGrid() {
        const now = new Date();
        const year = now.getFullYear(), month = now.getMonth();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        /* Monday-first weekday index for day 1 */
        const startWeekday = (new Date(year, month, 1).getDay() + 6) % 7;

        const eventDays = new Set();
        for (const ev of this._filterEvents(this._events)) {
            const d = new Date(ev.start * 1000);
            if (d.getFullYear() === year && d.getMonth() === month) eventDays.add(d.getDate());
        }

        const grid = new St.BoxLayout({style_class: 'nexnotch-cal-month', vertical: true});
        grid.add_child(new St.Label({
            text: now.toLocaleDateString([], {month: 'long', year: 'numeric'}),
            style_class: 'nexnotch-cal-month-title',
            x_align: Clutter.ActorAlign.CENTER,
        }));

        const dow = new St.BoxLayout({style_class: 'nexnotch-cal-dow', x_expand: true});
        for (const d of ['M', 'T', 'W', 'T', 'F', 'S', 'S']) {
            dow.add_child(new St.Label({text: d, style_class: 'nexnotch-cal-dow-cell', x_align: Clutter.ActorAlign.CENTER, x_expand: true}));
        }
        grid.add_child(dow);

        let row = new St.BoxLayout({style_class: 'nexnotch-cal-week', x_expand: true});
        for (let i = 0; i < startWeekday; i++) row.add_child(new St.Widget({x_expand: true}));
        let col = startWeekday;
        for (let day = 1; day <= daysInMonth; day++) {
            const isToday = day === now.getDate();
            let cls = 'nexnotch-cal-day-cell';
            if (isToday) cls += ' today';
            if (eventDays.has(day)) cls += ' has-event';
            row.add_child(new St.Label({text: String(day), style_class: cls, x_align: Clutter.ActorAlign.CENTER, x_expand: true}));
            col++;
            if (col === 7) { grid.add_child(row); row = new St.BoxLayout({style_class: 'nexnotch-cal-week', x_expand: true}); col = 0; }
        }
        if (col > 0) grid.add_child(row);
        return grid;
    }

    _renderTasks() {
        const box = new St.BoxLayout({style_class: 'nexnotch-tasks', vertical: true, x_expand: true, y_expand: true});
        if (!_ECal) {
            box.add_child(new St.Label({
                text: 'libecal unavailable — install evolution-data-server',
                style_class: 'nexnotch-empty',
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
                style_class: 'nexnotch-empty',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return box;
        }

        /* segmented tab bar: "All" plus one tab per list, scrollable-ish
           row when there are many lists */
        if (lists.length > 1) {
            if (!this._activeTaskList) this._activeTaskList = 'All';
            if (this._activeTaskList !== 'All' && !lists.includes(this._activeTaskList)) this._activeTaskList = 'All';

            const listBar = new St.BoxLayout({style_class: 'nexnotch-task-lists', x_expand: true});
            const mkTab = (name, label) => {
                const active = name === this._activeTaskList;
                const btn = new St.Button({
                    style_class: 'nexnotch-task-list-tab' + (active ? ' active' : ''),
                    label,
                    x_expand: true,
                });
                btn.connect('clicked', () => { this._activeTaskList = name; this.emit('updated'); });
                listBar.add_child(btn);
            };
            mkTab('All', `All · ${tasks.length}`);
            for (const name of lists) mkTab(name, `${name} · ${byList.get(name).length}`);
            box.add_child(listBar);

            const items = this._activeTaskList === 'All' ? tasks : (byList.get(this._activeTaskList) ?? []);
            const scroll = new St.ScrollView({style_class: 'nexnotch-task-scroll', x_expand: true, y_expand: true});
            const inner = new St.BoxLayout({vertical: true, x_expand: true});
            for (const t of items.slice(0, 30)) inner.add_child(this._taskRow(t, this._activeTaskList === 'All'));
            scroll.set_child(inner);
            box.add_child(scroll);
        } else {
            const items = byList.get(lists[0]) ?? [];
            for (const t of items.slice(0, 12)) box.add_child(this._taskRow(t, false));
        }
        return box;
    }

    _taskRow(t, showList) {
        const row = new St.BoxLayout({style_class: 'nexnotch-task-row' + (t.done ? ' done' : '')});
        const check = new St.Button({style_class: 'nexnotch-task-check', label: t.done ? '☑' : '☐'});
        check.connect('clicked', () => this.toggleTask(t));
        row.add_child(check);
        const col = new St.BoxLayout({vertical: true, x_expand: true});
        col.add_child(new St.Label({text: t.title, style_class: 'nexnotch-task-title'}));
        if (showList && t.list) col.add_child(new St.Label({text: t.list, style_class: 'nexnotch-task-list-tag'}));
        row.add_child(col);
        if (t.due) row.add_child(new St.Label({text: this._formatDue(t.due), style_class: 'nexnotch-task-due'}));
        return row;
    }

    toggleTask(t) {
        const entry = this._taskClients.find(c => c.source.get_display_name() === t.list);
        if (!entry) return;
        try {
            entry.client.get_object(t.id, null, this._cancellable, (_, res) => {
                try {
                    const icalComp = entry.client.get_object_finish(res);
                    icalComp.set_status(t.done ? 'NEEDS-ACTION' : 'COMPLETED');
                    entry.client.modify_object(icalComp, _ECal.ObjModType.ALL, this._cancellable, () => {
                        this._refreshTaskClient(entry.source, entry.client);
                    });
                } catch (e) { logError(e, 'nexnotch:tasks:toggle'); }
            });
        } catch (e) { logError(e, 'nexnotch:tasks:toggle'); }
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
