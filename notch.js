import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import {SystemMonitor}    from './modules/system.js';
import {DropShelf}        from './modules/dropshelf.js';
import {NotificationPeek} from './modules/notifications.js';
import {CalendarPeek}     from './modules/calendar.js';
import {MprisWatcher}     from './modules/mpris.js';
import {Notes}            from './modules/notes.js';
import {Weather}          from './modules/weather.js';
import {Pomodoro}         from './modules/pomodoro.js';
import {QuickHub}         from './modules/quick.js';
import {Stats}            from './modules/stats.js';

const HOVER_DELAY_MS    = 180;
const COLLAPSE_DELAY_MS = 300;
const ANIM_MS           = 260;
const PEEK_DURATION_MS  = 5500;

export const Notch = GObject.registerClass(
class Notch extends St.Widget {
    _init(extension) {
        super._init({
            name: 'mertnotch',
            style_class: 'mertnotch',
            reactive: true,
            track_hover: true,
            can_focus: false,
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });

        this._extension = extension;
        this._settings  = extension.getSettings();

        this._expanded    = false;
        this._peekActive  = false;
        this._hoverTimeout    = 0;
        this._collapseTimeout = 0;
        this._clockTimer      = 0;
        this._activeTab = 'system';

        this._loadDims();
        this.set_size(this._cwMin, this._ch);

        this._buildLayers();
        this._setupDnd();
        this._applyColors();
        this._hideDateMenuIfRequested();

        this._modules = {
            system:        new SystemMonitor(this._settings),
            dropshelf:     new DropShelf(this._settings),
            notifications: new NotificationPeek(this._settings),
            calendar:      new CalendarPeek(this._settings),
            mpris:         new MprisWatcher(),
            notes:         new Notes(this._settings),
            weather:       new Weather(this._settings),
            pomodoro:      new Pomodoro(this._settings),
            quick:         new QuickHub(this._settings),
            stats:         new Stats(this._settings),
        };
        this._modules.notes.setGrabActor(this);
        /* show pomodoro mini label at startup with idle styling */
        this._pomoUpdateId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._pomoUpdateId = 0;
            if (this._stopped) return GLib.SOURCE_REMOVE;
            this._updatePomodoroIndicator();
            return GLib.SOURCE_REMOVE;
        });

        this._modules.system.connect('updated',             (_, s)      => this._onSystemUpdated(s));
        this._modules.notifications.connect('peek',         (_, src, n) => this._peekNotification(src, n));
        this._modules.dropshelf.connect('count-changed',    (_, n)      => this._updateShelfIndicator(n));
        this._modules.dropshelf.connect('request-add-file', ()          => this.openFilePicker());
        this._modules.calendar.connect('updated', () => {
            if (this._expanded && (this._activeTab === 'calendar' || this._activeTab === 'tasks')) {
                this._renderTab();
            }
        });
        this._modules.mpris.connect('changed',              (_, info)   => this._updateMedia(info));
        this._modules.weather.connect('updated',            ()          => { if (this._expanded && this._activeTab === 'weather') this._renderTab(); });
        this._modules.pomodoro.connect('tick',              ()          => { if (this._expanded && this._activeTab === 'pomodoro') this._renderTab(); this._updatePomodoroIndicator(); });
        this._modules.pomodoro.connect('state',             ()          => { if (this._expanded && this._activeTab === 'pomodoro') this._renderTab(); this._updatePomodoroIndicator(); });
        this._modules.quick.connect('updated',              ()          => { if (this._expanded && this._activeTab === 'quick') this._renderTab(); this._updatePrivacyIndicator(); });

        this._hoverHandlerId = this.connect('notify::hover', () => this._onHoverChanged());
        this.connect('destroy', () => this._onDestroy());

        this._settingsSig = this._settings.connect('changed', (_, key) => this._onSettingChanged(key));
    }

    _loadDims() {
        this._cwMin = this._settings.get_int('collapsed-width');
        this._ch    = this._settings.get_int('collapsed-height');
        this._ew    = this._settings.get_int('expanded-width');
        this._eh    = this._settings.get_int('expanded-height');
        this._radius = this._settings.get_int('corner-radius');
    }

    _measureCollapsedWidth() {
        try {
            const [, natW] = this._collapsed.get_preferred_width(this._ch);
            return Math.max(this._cwMin, natW);
        } catch (_) { return this._cwMin; }
    }

    _resizeCollapsed(animate = true) {
        if (this._expanded || this._peekActive) return;
        const target = this._measureCollapsedWidth();
        if (animate) {
            this.remove_all_transitions();
            this.ease({
                width: target, height: this._ch,
                duration: 180, mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            });
        } else {
            this.set_size(target, this._ch);
        }
    }

    _applyColors() {
        let bg = this._settings.get_string('bg-color') || '';
        if (!bg.match(/^rgba?\(/)) bg = 'rgb(0, 0, 0)';
        const accent   = this._settings.get_string('accent-color');
        const radius   = this._settings.get_int('corner-radius');
        const bgStyle = `
            background-color: ${bg};
            border-radius: 0 0 ${radius}px ${radius}px;
            border: 1px solid rgba(255, 255, 255, 0.06);
            border-top: 0;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
        `;
        this._bg.set_style(bgStyle);
        this.set_style(`background-color: ${bg};`);

        /* Clutter.Color belt — bypasses CSS entirely so blur-my-shell/other
           panel effects cannot leak through. Applied on top of set_style. */
        try {
            const [ok, col] = Clutter.Color.from_string(bg);
            if (ok) {
                this._bg.set_background_color(col);
                this.set_background_color(col);
            }
        } catch (_) {}

        for (const [tid, btn] of Object.entries(this._tabButtons ?? {})) {
            if (tid === this._activeTab) {
                btn.set_style(`background-color: rgba(255,255,255,0.14); color: white; border-radius: 7px; box-shadow: 0 1px 2px rgba(0,0,0,0.35);`);
            } else {
                btn.set_style('background-color: transparent; color: rgba(255,255,255,0.58); border-radius: 7px;');
            }
        }
        this._accentColor = accent;
        this._bgStyle = bgStyle;

        this._updateBatteryIcon();
    }

    _hideDateMenuIfRequested() {
        const wantHide = this._settings.get_boolean('hide-datemenu');
        const dm = Main.panel.statusArea?.dateMenu;
        if (!dm?.container) return;
        if (wantHide) {
            if (this._dmWasVisible === undefined) this._dmWasVisible = dm.container.visible;
            dm.container.visible = false;
        } else if (this._dmWasVisible !== undefined) {
            dm.container.visible = this._dmWasVisible;
        }
    }

    _restoreDateMenu() {
        const dm = Main.panel.statusArea?.dateMenu;
        if (dm?.container && this._dmWasVisible !== undefined) {
            dm.container.visible = this._dmWasVisible;
        }
    }

    _onSettingChanged(key) {
        if (key.startsWith('collapsed-') || key.startsWith('expanded-') || key === 'corner-radius') {
            this._loadDims();
            if (!this._expanded && !this._peekActive) this._resizeCollapsed(false);
            if (this._expanded) this.set_size(this._ew, this._eh);
            this._applyColors();
        }
        if (['bg-color', 'accent-color', 'corner-radius',
             'battery-charging-color', 'battery-normal-color', 'battery-low-color'].includes(key)) {
            this._applyColors();
        }
        if (key === 'hide-datemenu') this._hideDateMenuIfRequested();
        if (key === 'clock-format' || key === 'show-seconds' || key === 'show-date') {
            this._updateClocks();
            this._resizeCollapsed();
        }
        if (key.startsWith('show-') && key !== 'show-seconds' && key !== 'show-date') {
            for (const [id, btn] of Object.entries(this._tabButtons ?? {})) {
                btn.visible = this._tabEnabled(id);
            }
            /* If the currently-active tab was disabled, switch to System. */
            if (!this._tabEnabled(this._activeTab)) this._switchTab('system');
            /* also start/stop the corresponding module so polling matches UI */
            this._reconcileModulesWithPrefs();
        }
    }

    _buildLayers() {
        this._bg = new St.Widget({style_class: 'mertnotch-bg', x_expand: true, y_expand: true});
        this.add_child(this._bg);

        /* collapsed layout:  [battery] [media]   HH:MM   [date]   [shelf#] */
        this._collapsed = new St.BoxLayout({
            style_class: 'mertnotch-collapsed',
            vertical: false,
            x_expand: true, y_expand: true,
        });
        this.add_child(this._collapsed);

        /* left cluster */
        this._leftCluster = new St.BoxLayout({style_class: 'mertnotch-cluster mertnotch-left', vertical: false});
        this._batteryIcon = new St.Icon({
            icon_name: 'battery-full-symbolic',
            icon_size: 14,
            style_class: 'mertnotch-battery-icon',
            visible: false,
        });
        this._mediaIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 14,
            style_class: 'mertnotch-media-icon',
            visible: false,
        });
        /* statusDot / privacyDot removed — see note above */
        /* statusDot (hot CPU/RAM/temp) and privacyDot (mic/cam) removed per
           user request — battery icon conveys charge, and user finds extra
           coloured dots redundant. Privacy state is still visible in the
           Quick tab. */
        this._pomoLabel = new St.Label({text: '', style_class: 'mertnotch-pomo-mini', visible: false, y_align: Clutter.ActorAlign.CENTER});
        this._leftCluster.add_child(this._pomoLabel);
        this._leftCluster.add_child(this._batteryIcon);
        this._leftCluster.add_child(this._mediaIcon);
        /* music pill — extends the collapsed notch with track title + artist
           in the Dynamic Island / NotchNook style when MPRIS is active */
        this._musicPill = new St.BoxLayout({
            style_class: 'mertnotch-music-pill',
            vertical: false,
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._musicTitle  = new St.Label({style_class: 'mertnotch-music-title'});
        this._musicArtist = new St.Label({style_class: 'mertnotch-music-artist'});
        this._musicPill.add_child(this._musicTitle);
        this._musicPill.add_child(new St.Label({text: ' · ', style_class: 'mertnotch-music-sep'}));
        this._musicPill.add_child(this._musicArtist);
        this._leftCluster.add_child(this._musicPill);

        /* center clock */
        this._centerCluster = new St.BoxLayout({
            style_class: 'mertnotch-cluster mertnotch-center',
            vertical: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._clockLabel = new St.Label({text: '', style_class: 'mertnotch-clock', y_align: Clutter.ActorAlign.CENTER});
        this._centerCluster.add_child(this._clockLabel);

        /* right cluster: date + shelf badge */
        this._rightCluster = new St.BoxLayout({style_class: 'mertnotch-cluster mertnotch-right', vertical: false});
        this._dateLabelC = new St.Label({text: '', style_class: 'mertnotch-date-mini', y_align: Clutter.ActorAlign.CENTER});
        this._shelfBadge = new St.Label({text: '', style_class: 'mertnotch-shelf-badge', visible: false, y_align: Clutter.ActorAlign.CENTER});
        /* pomoLabel now lives in _leftCluster (user-preferred position) */
        this._rightCluster.add_child(this._dateLabelC);
        this._rightCluster.add_child(this._shelfBadge);

        this._collapsed.add_child(this._leftCluster);
        this._collapsed.add_child(this._centerCluster);
        this._collapsed.add_child(this._rightCluster);

        /* expanded layer */
        this._expandedLayer = new St.BoxLayout({
            style_class: 'mertnotch-expanded',
            vertical: true,
            x_expand: true, y_expand: true,
            opacity: 0,
            visible: false,
        });
        this.add_child(this._expandedLayer);

        this._header = new St.BoxLayout({style_class: 'mertnotch-header', vertical: false});
        this._bigClock  = new St.Label({text: '', style_class: 'mertnotch-big-clock'});
        this._dateLabel = new St.Label({text: '', style_class: 'mertnotch-date'});
        this._header.add_child(this._bigClock);
        this._header.add_child(new St.Widget({x_expand: true}));
        this._header.add_child(this._dateLabel);
        this._expandedLayer.add_child(this._header);

        this._tabs = new St.BoxLayout({style_class: 'mertnotch-tabs', vertical: false});
        this._content = new St.Bin({style_class: 'mertnotch-content', x_expand: true, y_expand: true});
        this._expandedLayer.add_child(this._tabs);
        this._expandedLayer.add_child(this._content);

        this._tabButtons = {};
        const tabIds = ['system', 'calendar', 'tasks', 'shelf', 'notes', 'weather', 'pomodoro', 'stats', 'quick'];
        for (const id of tabIds) {
            const btn = new St.Button({
                style_class: 'mertnotch-tab',
                label: this._tabLabel(id),
                can_focus: true,
                x_expand: true,
                track_hover: true,
                visible: this._tabEnabled(id),
            });
            btn.connect('clicked', () => this._switchTab(id));
            this._tabs.add_child(btn);
            this._tabButtons[id] = btn;
        }

        this._peekLayer = null;
    }

    _setupDnd() {
        this._delegate = this;
        if (Main.xdndHandler) {
            this._xdndBeginId = Main.xdndHandler.connect('drag-begin', () => {
                this._xdndActive = true;
                if (!this._expanded) {
                    this._clearHoverTimeout();
                    this._switchTab('shelf');
                    this._expand();
                } else {
                    this._switchTab('shelf');
                }
                this._bg?.add_style_class_name('drag-active');
            });
            this._xdndEndId = Main.xdndHandler.connect('drag-end', () => {
                this._xdndActive = false;
                this._bg?.remove_style_class_name('drag-active');
                if (!this.hover) this._scheduleCollapse();
            });
        }
        try {
            Main.wm.addKeybinding('shortcut-filepicker',
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this.openFilePicker());
            Main.wm.addKeybinding('shortcut-toggle',
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this._expanded ? this._collapse() : this._expand());
            this._keybindings = ['shortcut-filepicker', 'shortcut-toggle'];
        } catch (e) { logError(e, 'mertnotch:keybinding'); }
    }

    acceptDrop(source) {
        const uris = this._extractUris(source);
        if (uris.length === 0) return false;
        for (const uri of uris) this._modules.dropshelf.addURI(uri);
        return true;
    }

    handleDragOver(source) {
        if (!this._expanded) this._scheduleExpand();
        const uris = this._extractUris(source);
        return uris.length ? DND.DragMotionResult.COPY_DROP : DND.DragMotionResult.CONTINUE;
    }

    _extractUris(source) {
        if (!source) return [];
        if (source.getDragActorSource) {
            const s = source.getDragActorSource();
            if (s?.uri)  return [s.uri];
            if (s?.uris) return s.uris;
            if (s?.file) return [s.file.get_uri()];
        }
        if (source.uri)  return [source.uri];
        if (source.uris) return source.uris;
        if (source.file) return [source.file.get_uri()];
        if (source.uriList) return source.uriList;
        return [];
    }

    _tabLabel(id) {
        return {
            system: 'System', calendar: 'Cal', tasks: 'Tasks', shelf: 'Shelf',
            notes:  'Notes',  weather:  'Weather', pomodoro: 'Timer',
            stats:  'Stats',  quick: 'Quick',
        }[id] ?? id;
    }

    _tabEnabled(id) {
        const key = {
            system:   'show-system',
            shelf:    'show-dropshelf',
            calendar: 'show-calendar',
            tasks:    'show-tasks',
            notes:    null,
            weather:  null,
            pomodoro: null,
            stats:    null,
            quick:    null,
        }[id];
        if (!key) return true;
        return this._settings.get_boolean(key);
    }

    start() {
        /* gate modules whose matching show-* key is off, so they don't poll
           resources in the background. start/stop is idempotent inside each
           module. */
        this._startEnabledModules();
        this._switchTab('system');
        this._startClock();
        this._updateBatteryIcon();
    }

    _startEnabledModules() {
        for (const [name, mod] of Object.entries(this._modules)) {
            if (this._moduleEnabled(name)) {
                try { mod.start?.(); mod._running = true; } catch (e) { logError(e); }
            } else {
                mod._running = false;
            }
        }
    }

    _reconcileModulesWithPrefs() {
        for (const [name, mod] of Object.entries(this._modules)) {
            const enabled = this._moduleEnabled(name);
            const running = !!mod._running;
            if (enabled && !running)  { try { mod.start?.(); mod._running = true;  } catch (e) { logError(e); } }
            if (!enabled && running)  { try { mod.stop?.();  mod._running = false; } catch (e) { logError(e); } }
        }
    }

    _moduleEnabled(name) {
        if (name === 'calendar')      return this._tabEnabled('calendar') || this._tabEnabled('tasks');
        if (name === 'dropshelf')     return this._tabEnabled('shelf');
        if (name === 'system')        return this._settings.get_boolean('show-system');
        if (name === 'notifications') return this._settings.get_boolean('show-notifications');
        return true;
    }

    stop() {
        this._stopped = true;
        this._clearHoverTimeout();
        this._clearCollapseTimeout();
        this._stopClock();
        if (this._pomoUpdateId) { GLib.source_remove(this._pomoUpdateId); this._pomoUpdateId = 0; }
        if (this._peekTimer)    { GLib.source_remove(this._peekTimer);    this._peekTimer    = 0; }
        for (const id of this._bannerKillTimers ?? []) {
            try { GLib.source_remove(id); } catch (_) {}
        }
        this._bannerKillTimers?.clear();
        for (const m of Object.values(this._modules)) m.stop?.();
        this._restoreDateMenu();
        if (this._settingsSig) { this._settings.disconnect(this._settingsSig); this._settingsSig = 0; }
        if (this._xdndBeginId && Main.xdndHandler) { Main.xdndHandler.disconnect(this._xdndBeginId); this._xdndBeginId = 0; }
        if (this._xdndEndId   && Main.xdndHandler) { Main.xdndHandler.disconnect(this._xdndEndId);   this._xdndEndId   = 0; }
        for (const key of this._keybindings ?? []) {
            try { Main.wm.removeKeybinding(key); } catch (_) {}
        }
        this._keybindings = [];
    }

    _onDestroy() {
        this._clearHoverTimeout();
        this._clearCollapseTimeout();
        this._stopClock();
        for (const m of Object.values(this._modules ?? {})) m.destroy?.();
        this._modules = {};
    }

    _startClock() {
        this._updateClocks();
        this._scheduleClockTick();
    }

    _scheduleClockTick() {
        const showSec = this._settings.get_boolean('show-seconds');
        const period  = showSec ? 1000 : 60000;
        const now = Date.now();
        const delay = Math.max(20, period - (now % period));
        this._clockTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._updateClocks();
            this._scheduleClockTick();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopClock() {
        if (this._clockTimer) { GLib.source_remove(this._clockTimer); this._clockTimer = 0; }
    }

    _updateClocks() {
        const now = new Date();
        const showSec   = this._settings.get_boolean('show-seconds');
        const showDate  = this._settings.get_boolean('show-date');
        const h12       = this._settings.get_string('clock-format') === '12h';
        const timeOpts = {
            hour: '2-digit', minute: '2-digit',
            hour12: h12,
            ...(showSec ? {second: '2-digit'} : {}),
        };
        const time = now.toLocaleTimeString([], timeOpts);
        this._clockLabel.text = time;
        this._bigClock.text   = time;
        if (showDate) {
            this._dateLabelC.text = this._formatCompactDate(now);
            this._dateLabelC.visible = true;
        } else {
            this._dateLabelC.visible = false;
        }
        this._dateLabel.text = now.toLocaleDateString([], {weekday: 'long', day: 'numeric', month: 'long'});
    }

    _formatCompactDate(d) {
        const day   = d.getDate();
        const month = d.toLocaleDateString([], {month: 'long'});
        /* Full name if ≤5 chars, otherwise first 3 chars (Turkish convention) */
        const display = month.length <= 5 ? month : month.slice(0, 3);
        return `${day} ${display}`;
    }

    _clearHoverTimeout()    { if (this._hoverTimeout)    { GLib.source_remove(this._hoverTimeout);    this._hoverTimeout = 0; } }
    _clearCollapseTimeout() { if (this._collapseTimeout) { GLib.source_remove(this._collapseTimeout); this._collapseTimeout = 0; } }

    _onHoverChanged() {
        if (this.hover) this._scheduleExpand();
        else            this._scheduleCollapse();
    }

    _pointerInside() {
        try {
            const [px, py] = global.get_pointer();
            const [ax, ay] = this.get_transformed_position();
            let aw, ah;
            if (this._expanded) { aw = this._ew; ah = this._eh; }
            else                { [aw, ah] = this.get_transformed_size(); }
            const margin = 8;
            return px >= (ax - margin) && px <= (ax + aw + margin) &&
                   py >= (ay - margin) && py <= (ay + ah + margin);
        } catch (_) { return this.hover; }
    }

    _scheduleExpand() {
        if (this._expanded) { this._clearCollapseTimeout(); return; }
        /* Don't hijack a notification click: when a peek is visible, the
           user's hover intent is almost always "I'm moving to click the
           banner", not "expand the notch". Suppress expansion while peek
           is up; they can still click the peek body to activate it, or
           wait for the peek to time out before hovering expands. */
        if (this._peekActive) return;
        this._clearHoverTimeout();
        this._hoverTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_DELAY_MS, () => {
            this._hoverTimeout = 0;
            if (this._peekActive) return GLib.SOURCE_REMOVE;
            if (this.hover || this._pointerInside() || this._xdndActive) this._expand();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleCollapse() {
        this._clearHoverTimeout();
        if (!this._expanded) return;
        this._clearCollapseTimeout();
        this._collapseTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COLLAPSE_DELAY_MS, () => {
            this._collapseTimeout = 0;
            if (this.hover || this._pointerInside() || this._xdndActive || this._notesFocused) {
                this._scheduleCollapse();
                return GLib.SOURCE_REMOVE;
            }
            this._collapse();
            return GLib.SOURCE_REMOVE;
        });
    }

    _expand() {
        if (this._peekActive) this._dismissPeek(true);
        this._expanded = true;
        this._expandedLayer.visible = true;
        this.remove_all_transitions();
        this.ease({
            width: this._ew, height: this._eh,
            duration: ANIM_MS, mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
        this._collapsed.ease({opacity: 0, duration: ANIM_MS * 0.4, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._collapsed.hide()});
        this._expandedLayer.opacity = 0;
        this._expandedLayer.scale_x = 0.96; this._expandedLayer.scale_y = 0.96;
        this._expandedLayer.set_pivot_point(0.5, 0);
        this._expandedLayer.ease({
            opacity: 255, scale_x: 1, scale_y: 1,
            duration: ANIM_MS * 1.1, mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
        this._updateClocks();
        this._renderTab();
        /* Auto-fit height to content after it's laid out. */
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._stopped) return GLib.SOURCE_REMOVE;
            if (this._expanded) this._resizeExpanded();
            return GLib.SOURCE_REMOVE;
        });
    }

    _collapse() {
        this._modules?.notes?._releaseGrab?.();
        this._expanded = false;
        this._modules?.system?.setFocused?.(false);
        this._collapsed.show();
        this.remove_all_transitions();
        const targetW = this._measureCollapsedWidth();
        this.ease({
            width: targetW, height: this._ch,
            duration: ANIM_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this._collapsed.ease({opacity: 255, duration: ANIM_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._expandedLayer.set_pivot_point(0.5, 0);
        this._expandedLayer.ease({
            opacity: 0, scale_x: 0.96, scale_y: 0.96,
            duration: ANIM_MS * 0.5, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => { this._expandedLayer.visible = false; },
        });
    }

    _switchTab(id) {
        if (this._activeTab === 'notes' && id !== 'notes') {
            this._modules?.notes?._releaseGrab?.();
        }
        this._activeTab = id;
        /* Bump system poll to user-selected fast rate only when user is
           actually looking at the system tab, otherwise fall back to 3x */
        this._modules?.system?.setFocused?.(this._expanded && id === 'system');
        const accent = this._accentColor ?? this._settings.get_string('accent-color');
        for (const [tid, btn] of Object.entries(this._tabButtons)) {
            if (tid === id) {
                btn.add_style_pseudo_class('active');
                btn.set_style(`background-color: rgba(255,255,255,0.14); color: white; border-radius: 7px; box-shadow: 0 1px 2px rgba(0,0,0,0.35);`);
            } else {
                btn.remove_style_pseudo_class('active');
                btn.set_style('background-color: transparent; color: rgba(255,255,255,0.58); border-radius: 7px;');
            }
        }
        this._renderTab();
    }

    _resizeExpanded() {
        if (!this._expanded || !this._expandedLayer) return;
        try {
            const [, natH] = this._expandedLayer.get_preferred_height(this._ew - 36);
            const target = Math.max(this._eh, Math.min(640, natH + 32));
            if (Math.abs(this.height - target) > 2) {
                this.ease({
                    width: this._ew, height: target,
                    duration: 220, mode: Clutter.AnimationMode.EASE_OUT_BACK,
                });
            }
        } catch (_) {}
    }

    _renderTab() {
        if (!this._expanded) return;
        const mod = {
            system:   this._modules.system,
            shelf:    this._modules.dropshelf,
            calendar: this._modules.calendar,
            tasks:    this._modules.calendar,
            notes:    this._modules.notes,
            weather:  this._modules.weather,
            pomodoro: this._modules.pomodoro,
            stats:    this._modules.stats,
            quick:    this._modules.quick,
        }[this._activeTab];
        /* System tab gets an optional music card passed in so the whole
           bottom-right corner can be used for media controls when MPRIS
           has an active player. */
        const extraArg = this._activeTab === 'system'
            ? this._buildMusicCard()
            : this._activeTab;
        const child = mod?.render?.(extraArg);
        this._content.set_child(child ?? new St.Label({text: '—', x_align: Clutter.ActorAlign.CENTER}));
        /* nudge height after child lays out */
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._stopped) return GLib.SOURCE_REMOVE;
            if (this._expanded) this._resizeExpanded();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onSystemUpdated(stats) {
        this._latestStats = stats;
        this._updateBatteryIcon(stats.battery);
        if (this._expanded && this._activeTab === 'system') this._renderTab();
    }

    _updateBatteryIcon(battery) {
        battery = battery ?? this._latestStats?.battery;
        if (!battery) { this._batteryIcon.visible = false; return; }
        const cap = battery.capacity;
        const status = (battery.status ?? '').toLowerCase();
        const plugged = !!battery.plugged;

        const draining = status === 'discharging';
        const charging = status === 'charging' || (plugged && !draining && cap < 100);
        const low = draining && cap < 20;

        /* Desktop with no real battery drain: hide icon entirely. */
        if (!draining && !plugged && cap === 0) {
            const wasVisible = this._batteryIcon.visible;
            this._batteryIcon.visible = false;
            if (wasVisible) this._resizeCollapsed();
            return;
        }

        let iconName;
        if (charging)         iconName = cap >= 95 ? 'battery-full-charging-symbolic' : 'battery-good-charging-symbolic';
        else if (cap >= 90)   iconName = 'battery-full-symbolic';
        else if (cap >= 55)   iconName = 'battery-good-symbolic';
        else if (cap >= 25)   iconName = 'battery-low-symbolic';
        else                  iconName = 'battery-caution-symbolic';

        let color;
        if (charging)      color = this._settings.get_string('battery-charging-color');
        else if (plugged)  color = this._settings.get_string('battery-charging-color'); /* plugged + full → green */
        else if (low)      color = this._settings.get_string('battery-low-color');
        else if (draining) color = this._settings.get_string('battery-normal-color');
        else               color = 'rgba(255, 255, 255, 0.78)';

        const wasVisible = this._batteryIcon.visible;
        this._batteryIcon.icon_name = iconName;
        this._batteryIcon.set_style(`color: ${color};`);
        this._batteryIcon.visible = true;
        if (!wasVisible) this._resizeCollapsed();
    }

    _updateMedia(info) {
        this._latestMedia = info;
        const wasIconVisible = this._mediaIcon.visible;
        const wasPillVisible = this._musicPill?.visible;
        if (!info?.playing && !info?.paused) {
            this._mediaIcon.visible = false;
            if (this._musicPill) this._musicPill.visible = false;
        } else {
            const iconName = this._resolveMediaIcon(info.icon) ?? 'audio-x-generic-symbolic';
            this._mediaIcon.icon_name = iconName;
            this._mediaIcon.opacity = info.playing ? 255 : 150;
            this._mediaIcon.visible = true;
            /* Dynamic Island: extend the collapsed pill with the track */
            if (this._musicPill && info.title) {
                const title = (info.title || '').slice(0, 24);
                const artist = (info.artist || '').slice(0, 22);
                this._musicTitle.text = title;
                this._musicArtist.text = artist;
                this._musicPill.visible = true;
            } else if (this._musicPill) {
                this._musicPill.visible = false;
            }
        }
        if (this._mediaIcon.visible !== wasIconVisible ||
            (this._musicPill && this._musicPill.visible !== wasPillVisible)) {
            this._resizeCollapsed();
        }
        /* Live-refresh System tab if music card is visible there */
        if (this._expanded && this._activeTab === 'system') this._renderTab();
    }

    _buildMusicCard() {
        const info = this._latestMedia;
        if (!info || (!info.playing && !info.paused)) return null;
        const card = new St.BoxLayout({style_class: 'mertnotch-music-card', vertical: true});
        const top = new St.BoxLayout({style_class: 'mertnotch-music-card-top'});
        let art = null;
        if (info.artUrl && info.artUrl.startsWith('file://')) {
            try {
                const path = decodeURIComponent(info.artUrl.slice(7));
                art = new St.Icon({gicon: Gio.FileIcon.new(Gio.File.new_for_path(path)), icon_size: 44, style_class: 'mertnotch-music-art'});
            } catch (_) {}
        }
        if (!art) {
            art = new St.Icon({icon_name: this._resolveMediaIcon(info.icon) ?? 'audio-x-generic-symbolic', icon_size: 32, style_class: 'mertnotch-music-art-fallback'});
        }
        top.add_child(art);
        const txt = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'mertnotch-music-txt', y_align: Clutter.ActorAlign.CENTER});
        txt.add_child(new St.Label({text: (info.title || 'Unknown').slice(0, 28), style_class: 'mertnotch-music-card-title'}));
        txt.add_child(new St.Label({text: (info.artist || '').slice(0, 28), style_class: 'mertnotch-music-card-artist'}));
        top.add_child(txt);
        card.add_child(top);

        const ctrls = new St.BoxLayout({style_class: 'mertnotch-music-ctrls', x_align: Clutter.ActorAlign.CENTER});
        const mk = (label, cb, accName, enabled = true) => {
            const b = new St.Button({style_class: 'mertnotch-music-btn', label, accessible_name: accName, can_focus: true, reactive: enabled});
            if (!enabled) b.add_style_class_name('disabled');
            if (enabled) b.connect('clicked', cb);
            return b;
        };
        ctrls.add_child(mk('⏮', () => this._modules.mpris.previous(), 'Previous track', info.canPrev));
        ctrls.add_child(mk(info.playing ? '⏸' : '▶', () => this._modules.mpris.playPause(), 'Play/pause', info.canPlay || info.canPause));
        ctrls.add_child(mk('⏭', () => this._modules.mpris.next(), 'Next track', info.canNext));
        card.add_child(ctrls);
        return card;
    }

    _resolveMediaIcon(desktopEntry) {
        if (!desktopEntry) return null;
        const app = Gio.DesktopAppInfo.new(`${desktopEntry}.desktop`);
        if (app) {
            const gicon = app.get_icon();
            if (gicon) {
                const name = gicon.to_string?.();
                if (name && !name.startsWith('/')) return name;
            }
        }
        const fallback = {
            spotify:         'spotify-client',
            'org.gnome.Decibels': 'org.gnome.Decibels',
            firefox:         'firefox',
            vlc:             'vlc',
            rhythmbox:       'rhythmbox',
        }[desktopEntry.toLowerCase()];
        return fallback ?? 'audio-x-generic-symbolic';
    }

    _updateShelfIndicator(n) {
        if (n > 0) { this._shelfBadge.text = `${n}`; this._shelfBadge.visible = true; }
        else       { this._shelfBadge.visible = false; }
        this._resizeCollapsed();
        /* if the user is looking at the Shelf tab while items come in, refresh it */
        if (this._expanded && this._activeTab === 'shelf') this._renderTab();
    }

    _updatePomodoroIndicator() {
        const p = this._modules?.pomodoro;
        if (!this._pomoLabel) return;
        const wasVisible = this._pomoLabel.visible;
        this._pomoLabel.remove_style_class_name('break');
        this._pomoLabel.remove_style_class_name('paused');
        if (!p || (!p.isActive() && p.getState() !== 'paused')) {
            /* Idle — hide completely. Pomo label only appears once the
               user has actually started a session. */
            this._pomoLabel.visible = false;
        } else if (p.isActive()) {
            this._pomoLabel.text = p.formatRemain();
            this._pomoLabel.visible = true;
            if (p.getState() === 'break' || p.getState() === 'longbreak') {
                this._pomoLabel.add_style_class_name('break');
            }
        } else {
            this._pomoLabel.text = `⏸ ${p.formatRemain()}`;
            this._pomoLabel.visible = true;
            this._pomoLabel.add_style_class_name('paused');
        }
        if (this._pomoLabel.visible !== wasVisible) this._resizeCollapsed();
    }

    _updatePrivacyIndicator() {
        /* no-op — privacy dot removed from collapsed pill per user request.
           Mic/Camera status is still visible in the Quick tab pills. */
    }

    _peekNotification(source, notif) {
        if (this._expanded) return;
        if (!this._settings.get_boolean('show-notifications')) return;   /* master off */
        this._dismissPeek(true);
        if (this._settings.get_boolean('notif-suppress-native')) {
            this._killBanner(0); this._killBanner(60); this._killBanner(220);
        }

        const title = notif?.title ?? source?.title ?? 'Notification';
        let body  = notif?.bannerBodyText ?? notif?.body ?? '';
        /* clamp extremely long notifications */
        const lines = body.split('\n');
        if (lines.length > 6) body = lines.slice(0, 6).join('\n') + '\n…';
        if (body.length > 360) body = body.slice(0, 360) + '…';
        const timeStr = new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});

        const peek = new St.BoxLayout({
            style_class: 'mertnotch-peek',
            vertical: false, x_expand: true, y_expand: true,
            reactive: true,
            track_hover: true,
            can_focus: true,
        });
        peek.set_style(this._bgStyle);

        /* Clicking the body of the peek activates the notification (opens
           the source app, marks as read, etc.) — same as clicking a native
           banner. The dismiss button shortcuts out below. */
        peek.connect('button-release-event', (_a, event) => {
            if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            try {
                if (typeof notif?.activate === 'function') notif.activate();
                else if (typeof source?.open === 'function') source.open();
            } catch (e) { logError(e, 'mertnotch:peek:activate'); }
            this._dismissPeek(false);
            return Clutter.EVENT_STOP;
        });

        const gicon = this._resolveNotifIcon(source, notif);
        const iconBin = new St.Bin({style_class: 'mertnotch-peek-icon-bin', y_align: Clutter.ActorAlign.CENTER});
        iconBin.set_child(new St.Icon({
            gicon, icon_size: 28,
            style_class: 'mertnotch-peek-icon',
        }));
        peek.add_child(iconBin);

        const textCol = new St.BoxLayout({
            vertical: true, x_expand: true, y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'mertnotch-peek-text',
        });
        const titleRow = new St.BoxLayout();
        titleRow.add_child(new St.Label({text: title, style_class: 'mertnotch-peek-title', x_expand: true}));
        titleRow.add_child(new St.Label({text: timeStr, style_class: 'mertnotch-peek-time'}));
        textCol.add_child(titleRow);
        if (body) textCol.add_child(new St.Label({text: body, style_class: 'mertnotch-peek-body'}));
        peek.add_child(textCol);

        const dismissBtn = new St.Button({
            style_class: 'mertnotch-peek-dismiss',
            label: '✕',
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Dismiss notification',
            can_focus: true,
        });
        dismissBtn.connect('clicked', () => this._dismissPeek(false));
        /* Stop the click from bubbling up to the peek (which would activate
           the notification on top of dismissing it). */
        dismissBtn.connect('button-release-event', () => Clutter.EVENT_STOP);
        peek.add_child(dismissBtn);

        this.add_child(peek);
        this._peekLayer  = peek;
        this._peekActive = true;
        this._collapsed.hide();

        this.remove_all_transitions();
        peek.opacity = 0;
        peek.set_pivot_point(0.5, 0);
        peek.scale_x = 0.94; peek.scale_y = 0.94;
        peek.ease({
            opacity: 255, scale_x: 1, scale_y: 1,
            duration: 300, mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
        /* Fit size to actual text (multi-line messages, short toasts, etc.) */
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this._peekActive) return GLib.SOURCE_REMOVE;
            const width = 540;
            const [, natH] = peek.get_preferred_height(width - 40);
            const h = Math.max(72, Math.min(260, natH + 20));
            this.ease({width, height: h, duration: 260, mode: Clutter.AnimationMode.EASE_OUT_BACK});
            return GLib.SOURCE_REMOVE;
        });

        this._peekTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PEEK_DURATION_MS, () => {
            this._peekTimer = 0; this._dismissPeek(false); return GLib.SOURCE_REMOVE;
        });
    }

    _killBanner(delayMs) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._bannerKillTimers?.delete(id);
            try { Main.messageTray._banner?.close?.(); } catch (_) {}
            try { Main.messageTray._bannerBin?.hide?.(); } catch (_) {}
            return GLib.SOURCE_REMOVE;
        });
        (this._bannerKillTimers ??= new Set()).add(id);
    }

    _resolveNotifIcon(source, notif) {
        try {
            if (notif?.gicon)    return notif.gicon;
            if (source?.getIcon) return source.getIcon();
            if (source?.icon)    return source.icon;
        } catch (_) {}
        return Gio.ThemedIcon.new('dialog-information-symbolic');
    }

    _dismissPeek(immediate) {
        if (this._peekTimer) { GLib.source_remove(this._peekTimer); this._peekTimer = 0; }
        if (!this._peekActive) return;
        this._peekActive = false;
        const finalize = () => {
            this._peekLayer?.destroy();
            this._peekLayer = null;
            if (!this._expanded) {
                this._collapsed.show();
                this.ease({width: this._measureCollapsedWidth(), height: this._ch, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_EXPO});
            }
        };
        if (immediate) finalize();
        else GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { finalize(); return GLib.SOURCE_REMOVE; });
    }

    openFilePicker() {
        const zenity = GLib.find_program_in_path('zenity');
        if (!zenity) {
            log('mertnotch: zenity not installed — drag-drop via `+ Add` is unavailable');
            return;
        }
        try {
            const proc = Gio.Subprocess.new(
                [zenity, '--file-selection', '--multiple', '--separator=\n', '--title=Add to notch shelf'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout] = p.communicate_utf8_finish(res);
                    if (!stdout) return;
                    for (const line of stdout.trim().split('\n').filter(Boolean)) {
                        const uri = line.startsWith('/') ? Gio.File.new_for_path(line).get_uri() : line;
                        this._modules.dropshelf.addURI(uri);
                    }
                } catch (e) { logError(e, 'mertnotch:filepicker:finish'); }
            });
        } catch (e) {
            logError(e, 'mertnotch:filepicker');
        }
    }
});
