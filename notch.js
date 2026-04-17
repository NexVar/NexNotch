import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import {SystemMonitor}   from './modules/system.js';
import {DropShelf}       from './modules/dropshelf.js';
import {NotificationPeek} from './modules/notifications.js';
import {CalendarPeek}    from './modules/calendar.js';

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
        this.set_size(this._cw, this._ch);

        this._buildLayers();
        this._setupDnd();
        this._applySettings();

        this._modules = {
            system:        new SystemMonitor(this._settings),
            dropshelf:     new DropShelf(this._settings),
            notifications: new NotificationPeek(this._settings),
            calendar:      new CalendarPeek(this._settings),
        };

        this._modules.system.connect('updated',             (_, s)      => this._onSystemUpdated(s));
        this._modules.notifications.connect('peek',         (_, src, n) => this._peekNotification(src, n));
        this._modules.dropshelf.connect('count-changed',    (_, n)      => this._updateShelfIndicator(n));
        this._modules.dropshelf.connect('request-add-file', ()          => this.openFilePicker());
        this._modules.calendar.connect('updated',           ()          => { if (this._expanded) this._renderTab(); });

        this._hoverHandlerId = this.connect('notify::hover', () => this._onHoverChanged());
        this.connect('destroy', () => this._onDestroy());

        this._settingsSig = this._settings.connect('changed', (_, key) => this._onSettingChanged(key));
    }

    _loadDims() {
        this._cw = this._settings.get_int('collapsed-width');
        this._ch = this._settings.get_int('collapsed-height');
        this._ew = this._settings.get_int('expanded-width');
        this._eh = this._settings.get_int('expanded-height');
    }

    _applySettings() {
        this._hideDateMenuIfRequested();
        this._applyColors();
    }

    _applyColors() {
        const bgRgba   = this._settings.get_string('bg-color');
        const accent   = this._settings.get_string('accent-color');
        const radius   = this._settings.get_int('corner-radius');
        const hideBar  = this._settings.get_boolean('hide-top-bar-center');
        const style = `
            .mertnotch-bg {
                background-color: ${bgRgba};
                border-radius: 0 0 ${radius}px ${radius}px;
            }
            .mertnotch-peek {
                background-color: ${bgRgba};
                border-radius: 0 0 ${radius}px ${radius}px;
            }
            .mertnotch-tab:active, .mertnotch-tab:active:hover {
                background-color: ${accent};
            }
            .mertnotch-shelf-dest, .mertnotch-cal-when {
                color: ${accent};
            }
            .mertnotch-bar-fill {
                background-color: ${accent};
            }
        `;
        if (!this._styleBin) {
            this._styleBin = new St.Widget({visible: false});
            Main.layoutManager.addChrome(this._styleBin);
        }
        this._styleBin.set_style(style);
    }

    _hideDateMenuIfRequested() {
        const wantHide = this._settings.get_boolean('hide-datemenu');
        const dm = Main.panel.statusArea?.dateMenu;
        if (!dm?.container) return;
        if (wantHide) {
            if (this._dmWasVisible === undefined) this._dmWasVisible = dm.container.visible;
            dm.container.visible = false;
        } else {
            if (this._dmWasVisible !== undefined) dm.container.visible = this._dmWasVisible;
        }
    }

    _restoreDateMenu() {
        const dm = Main.panel.statusArea?.dateMenu;
        if (dm?.container && this._dmWasVisible !== undefined) {
            dm.container.visible = this._dmWasVisible;
        }
    }

    _onSettingChanged(key) {
        if (key.startsWith('collapsed-') || key.startsWith('expanded-')) {
            this._loadDims();
            if (!this._expanded && !this._peekActive) this.set_size(this._cw, this._ch);
            if (this._expanded) this.set_size(this._ew, this._eh);
        }
        if (['bg-color', 'accent-color', 'corner-radius'].includes(key)) this._applyColors();
        if (key === 'hide-datemenu') this._hideDateMenuIfRequested();
        if (key === 'clock-format' || key === 'show-seconds' || key === 'show-date') this._updateClocks();
    }

    _buildLayers() {
        this._bg = new St.Widget({style_class: 'mertnotch-bg', x_expand: true, y_expand: true});
        this.add_child(this._bg);

        this._collapsed = new St.BoxLayout({
            style_class: 'mertnotch-collapsed',
            vertical: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._collapsed);

        this._statusDot  = new St.Widget({style_class: 'mertnotch-dot', visible: false});
        this._dateLabelC = new St.Label({text: '', style_class: 'mertnotch-date-mini'});
        this._clockLabel = new St.Label({text: '', style_class: 'mertnotch-clock'});
        this._shelfBadge = new St.Label({text: '', style_class: 'mertnotch-shelf-badge', visible: false});

        this._collapsed.add_child(this._statusDot);
        this._collapsed.add_child(this._dateLabelC);
        this._collapsed.add_child(this._clockLabel);
        this._collapsed.add_child(this._shelfBadge);

        this._expandedLayer = new St.BoxLayout({
            style_class: 'mertnotch-expanded',
            vertical: true,
            x_expand: true, y_expand: true,
            opacity: 0,
            visible: false,
        });
        this.add_child(this._expandedLayer);

        this._header = new St.BoxLayout({style_class: 'mertnotch-header', vertical: false});
        this._bigClock = new St.Label({text: '', style_class: 'mertnotch-big-clock'});
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
        for (const id of ['system', 'calendar', 'tasks', 'shelf']) {
            const btn = new St.Button({
                style_class: 'mertnotch-tab',
                label: this._tabLabel(id),
                can_focus: true,
                x_expand: true,
                track_hover: true,
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
                this._scheduleExpand();
            });
            this._xdndEndId = Main.xdndHandler.connect('drag-end', () => {
                this._xdndActive = false;
            });
        }
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
        return {system: 'System', calendar: 'Calendar', tasks: 'Tasks', shelf: 'Shelf'}[id] ?? id;
    }

    start() {
        for (const m of Object.values(this._modules)) m.start?.();
        this._switchTab('system');
        this._startClock();
    }

    stop() {
        this._clearHoverTimeout();
        this._clearCollapseTimeout();
        this._stopClock();
        for (const m of Object.values(this._modules)) m.stop?.();
        this._restoreDateMenu();
        if (this._settingsSig) { this._settings.disconnect(this._settingsSig); this._settingsSig = 0; }
        if (this._xdndBeginId && Main.xdndHandler) { Main.xdndHandler.disconnect(this._xdndBeginId); this._xdndBeginId = 0; }
        if (this._xdndEndId   && Main.xdndHandler) { Main.xdndHandler.disconnect(this._xdndEndId);   this._xdndEndId   = 0; }
        if (this._styleBin) { Main.layoutManager.removeChrome(this._styleBin); this._styleBin.destroy(); this._styleBin = null; }
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
        const doSeconds = this._settings.get_boolean('show-seconds');
        const delay = doSeconds ? 1000 : ((60 - new Date().getSeconds()) * 1000 + 50);
        this._clockTimer = GLib.timeout_add(GLib.PRIORITY_LOW, delay, () => {
            this._updateClocks();
            const period = this._settings.get_boolean('show-seconds') ? 1000 : 60000;
            this._clockTimer = GLib.timeout_add(GLib.PRIORITY_LOW, period, () => {
                this._updateClocks();
                return GLib.SOURCE_CONTINUE;
            });
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
        const timeOpts  = showSec
            ? {hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false}
            : {hour: '2-digit', minute: '2-digit',                     hour12: false};
        const time = now.toLocaleTimeString([], timeOpts);
        this._clockLabel.text = time;
        this._bigClock.text   = time;
        if (showDate) {
            this._dateLabelC.text = now.toLocaleDateString([], {day: 'numeric', month: 'short'});
            this._dateLabelC.visible = true;
        } else {
            this._dateLabelC.visible = false;
        }
        this._dateLabel.text = now.toLocaleDateString([], {weekday: 'long', day: 'numeric', month: 'long'});
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
            const [aw, ah] = this.get_transformed_size();
            return px >= ax && px <= ax + aw && py >= ay && py <= ay + ah;
        } catch (_) { return this.hover; }
    }

    _scheduleExpand() {
        if (this._expanded) { this._clearCollapseTimeout(); return; }
        this._clearHoverTimeout();
        this._hoverTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_DELAY_MS, () => {
            this._hoverTimeout = 0;
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
            if (this.hover || this._pointerInside() || this._xdndActive) {
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
            duration: ANIM_MS, mode: Clutter.AnimationMode.EASE_OUT_EXPO,
        });
        this._collapsed.ease({opacity: 0, duration: ANIM_MS * 0.4, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._collapsed.hide()});
        this._expandedLayer.opacity = 0;
        this._expandedLayer.ease({opacity: 255, duration: ANIM_MS * 0.9, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._updateClocks();
        this._renderTab();
    }

    _collapse() {
        this._expanded = false;
        this._collapsed.show();
        this.remove_all_transitions();
        this.ease({
            width: this._cw, height: this._ch,
            duration: ANIM_MS, mode: Clutter.AnimationMode.EASE_OUT_EXPO,
        });
        this._collapsed.ease({opacity: 255, duration: ANIM_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._expandedLayer.ease({opacity: 0, duration: ANIM_MS * 0.4, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => { this._expandedLayer.visible = false; }});
    }

    _switchTab(id) {
        this._activeTab = id;
        for (const [tid, btn] of Object.entries(this._tabButtons)) {
            btn.remove_style_pseudo_class('active');
            if (tid === id) btn.add_style_pseudo_class('active');
        }
        this._renderTab();
    }

    _renderTab() {
        if (!this._expanded) return;
        const mod = {
            system:   this._modules.system,
            shelf:    this._modules.dropshelf,
            calendar: this._modules.calendar,
            tasks:    this._modules.calendar,
        }[this._activeTab];
        const child = mod?.render?.(this._activeTab);
        this._content.set_child(child ?? new St.Label({text: '—', x_align: Clutter.ActorAlign.CENTER}));
    }

    _onSystemUpdated(stats) {
        this._latestStats = stats;
        const hot = stats.cpu > 85 || stats.ram > 90 || stats.temp > 85;
        this._statusDot.visible = hot;
        this._statusDot.set_style_class_name('mertnotch-dot' + (hot ? ' hot' : ''));
        if (this._expanded && this._activeTab === 'system') this._renderTab();
    }

    _updateShelfIndicator(n) {
        if (n > 0) { this._shelfBadge.text = `${n}`; this._shelfBadge.visible = true; }
        else       { this._shelfBadge.visible = false; }
    }

    _peekNotification(source, notif) {
        if (this._expanded) return;
        this._dismissPeek(true);
        const title = notif?.title ?? source?.title ?? 'Notification';
        const body  = notif?.bannerBodyText ?? notif?.body ?? '';
        const peek = new St.BoxLayout({style_class: 'mertnotch-peek', vertical: true, x_expand: true, y_expand: true});
        peek.add_child(new St.Label({text: title, style_class: 'mertnotch-peek-title'}));
        if (body) peek.add_child(new St.Label({text: body, style_class: 'mertnotch-peek-body'}));
        this.add_child(peek);
        this._peekLayer  = peek;
        this._peekActive = true;
        this._collapsed.hide();

        this.remove_all_transitions();
        this.ease({width: 460, height: 76, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_EXPO});

        this._peekTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PEEK_DURATION_MS, () => {
            this._peekTimer = 0; this._dismissPeek(false); return GLib.SOURCE_REMOVE;
        });
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
                this.ease({width: this._cw, height: this._ch, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_EXPO});
            }
        };
        if (immediate) finalize();
        else GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { finalize(); return GLib.SOURCE_REMOVE; });
    }

    openFilePicker() {
        try {
            const proc = Gio.Subprocess.new(
                ['zenity', '--file-selection', '--multiple', '--separator=\n', '--title=Add to notch shelf'],
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
