import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import {SystemMonitor} from './modules/system.js';
import {DropShelf}     from './modules/dropshelf.js';
import {NotificationPeek} from './modules/notifications.js';
import {CalendarPeek}  from './modules/calendar.js';

const COLLAPSED_W = 160;
const COLLAPSED_H = 28;
const EXPANDED_W  = 560;
const EXPANDED_H  = 240;
const HOVER_DELAY_MS = 220;
const ANIM_MS = 220;
const PEEK_DURATION_MS = 5500;

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
            width: COLLAPSED_W,
            height: COLLAPSED_H,
        });

        this._extension = extension;
        this._settings = extension.getSettings();

        this._expanded = false;
        this._peekActive = false;
        this._hoverTimeout = 0;
        this._collapseTimeout = 0;
        this._activeTab = 'system';

        this._buildLayers();
        this._setupDnd();

        this._modules = {
            system:        new SystemMonitor(this._settings),
            dropshelf:     new DropShelf(this._settings),
            notifications: new NotificationPeek(this._settings),
            calendar:      new CalendarPeek(this._settings),
        };

        this._modules.system.connect('updated',        (_, s)       => this._onSystemUpdated(s));
        this._modules.notifications.connect('peek',    (_, src, n)  => this._peekNotification(src, n));
        this._modules.dropshelf.connect('count-changed', (_, n)     => this._updateShelfIndicator(n));
        this._modules.calendar.connect('updated',      ()           => { if (this._expanded) this._renderTab(); });

        this.connect('enter-event',  () => this._scheduleExpand());
        this.connect('leave-event',  () => this._scheduleCollapse());
        this.connect('destroy',      () => this._onDestroy());
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

        this._indicator = new St.Label({text: '', style_class: 'mertnotch-indicator'});
        this._shelfBadge = new St.Label({text: '', style_class: 'mertnotch-shelf-badge', visible: false});
        this._collapsed.add_child(this._indicator);
        this._collapsed.add_child(this._shelfBadge);

        this._expandedLayer = new St.BoxLayout({
            style_class: 'mertnotch-expanded',
            vertical: true,
            x_expand: true,
            y_expand: true,
            opacity: 0,
            visible: false,
        });
        this.add_child(this._expandedLayer);

        this._tabs = new St.BoxLayout({style_class: 'mertnotch-tabs', vertical: false});
        this._content = new St.Bin({style_class: 'mertnotch-content', x_expand: true, y_expand: true});
        this._expandedLayer.add_child(this._tabs);
        this._expandedLayer.add_child(this._content);

        this._tabButtons = {};
        for (const id of ['system', 'shelf', 'calendar', 'tasks']) {
            const btn = new St.Button({
                style_class: 'mertnotch-tab',
                label: this._tabLabel(id),
                can_focus: true,
                x_expand: true,
            });
            btn.connect('clicked', () => this._switchTab(id));
            this._tabs.add_child(btn);
            this._tabButtons[id] = btn;
        }

        this._peekLayer = null;
    }

    _setupDnd() {
        this._delegate = this;
    }

    acceptDrop(source, _actor, _x, _y, _time) {
        const uris = this._extractUris(source);
        if (uris.length === 0) return false;
        for (const uri of uris) this._modules.dropshelf.addURI(uri);
        return true;
    }

    handleDragOver(source, _actor, _x, _y, _time) {
        const uris = this._extractUris(source);
        if (uris.length === 0) return DND.DragMotionResult.NO_DROP;
        if (!this._expanded) this._scheduleExpand();
        return DND.DragMotionResult.COPY_DROP;
    }

    _extractUris(source) {
        if (!source) return [];
        if (source.getDragActorSource) {
            const s = source.getDragActorSource();
            if (s?.uri)  return [s.uri];
            if (s?.uris) return s.uris;
        }
        if (source.uri)  return [source.uri];
        if (source.uris) return source.uris;
        if (source.file) return [source.file.get_uri()];
        return [];
    }

    _tabLabel(id) {
        return {system: 'System', shelf: 'Shelf', calendar: 'Calendar', tasks: 'Tasks'}[id] ?? id;
    }

    start() {
        for (const m of Object.values(this._modules)) m.start?.();
        this._switchTab('system');
    }

    stop() {
        this._clearHoverTimeout();
        this._clearCollapseTimeout();
        for (const m of Object.values(this._modules)) m.stop?.();
    }

    _onDestroy() {
        this._clearHoverTimeout();
        this._clearCollapseTimeout();
        for (const m of Object.values(this._modules)) m.destroy?.();
        this._modules = {};
    }

    _clearHoverTimeout() {
        if (this._hoverTimeout) { GLib.source_remove(this._hoverTimeout); this._hoverTimeout = 0; }
    }

    _clearCollapseTimeout() {
        if (this._collapseTimeout) { GLib.source_remove(this._collapseTimeout); this._collapseTimeout = 0; }
    }

    _scheduleExpand() {
        if (this._expanded) { this._clearCollapseTimeout(); return; }
        this._clearHoverTimeout();
        this._hoverTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_DELAY_MS, () => {
            this._hoverTimeout = 0;
            this._expand();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleCollapse() {
        this._clearHoverTimeout();
        if (!this._expanded) return;
        this._clearCollapseTimeout();
        this._collapseTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._collapseTimeout = 0;
            if (!this.has_pointer) this._collapse();
            return GLib.SOURCE_REMOVE;
        });
    }

    _expand() {
        if (this._peekActive) this._dismissPeek(true);
        this._expanded = true;
        this._expandedLayer.visible = true;
        this.remove_all_transitions();
        this.ease({
            width: EXPANDED_W, height: EXPANDED_H,
            duration: ANIM_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this._collapsed.ease({opacity: 0, duration: ANIM_MS / 2, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._collapsed.hide()});
        this._expandedLayer.opacity = 0;
        this._expandedLayer.ease({opacity: 255, duration: ANIM_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._renderTab();
    }

    _collapse() {
        this._expanded = false;
        this._collapsed.show();
        this.remove_all_transitions();
        this.ease({
            width: COLLAPSED_W, height: COLLAPSED_H,
            duration: ANIM_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this._collapsed.ease({opacity: 255, duration: ANIM_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._expandedLayer.ease({opacity: 0, duration: ANIM_MS / 2, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
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
        if (stats.cpu > 85 || stats.ram > 90) {
            this._indicator.add_style_class_name('hot');
        } else {
            this._indicator.remove_style_class_name('hot');
        }
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
        this._peekLayer = peek;
        this._peekActive = true;
        this._collapsed.hide();

        this.remove_all_transitions();
        this.ease({width: 420, height: 68, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});

        this._peekTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PEEK_DURATION_MS, () => {
            this._peekTimer = 0;
            this._dismissPeek(false);
            return GLib.SOURCE_REMOVE;
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
                this.ease({width: COLLAPSED_W, height: COLLAPSED_H, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            }
        };
        if (immediate) finalize();
        else GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { finalize(); return GLib.SOURCE_REMOVE; });
    }
});
