import GObject from 'gi://GObject';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const NotificationPeek = GObject.registerClass({
    Signals: {
        'peek': {param_types: [GObject.TYPE_JSOBJECT, GObject.TYPE_JSOBJECT]},
    },
}, class NotificationPeek extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._sourceAddedId = 0;
        this._sourceConns = new Map();
        this._pendingDismiss = new Map();
    }

    start() {
        const tray = Main.messageTray;
        if (!tray) return;
        this._sourceAddedId = tray.connect('source-added', (_, source) => this._trackSource(source));
        for (const source of tray.getSources()) this._trackSource(source);
    }

    stop() {
        if (this._sourceAddedId) {
            try { Main.messageTray.disconnect(this._sourceAddedId); } catch (_) {}
            this._sourceAddedId = 0;
        }
        for (const [source, id] of this._sourceConns) {
            try { source.disconnect(id); } catch (_) {}
        }
        this._sourceConns.clear();
        for (const t of this._pendingDismiss.values()) GLib.source_remove(t);
        this._pendingDismiss.clear();
    }

    destroy() { this.stop(); }

    _trackSource(source) {
        if (this._sourceConns.has(source)) return;
        const id = source.connect('notification-added', (_, notif) => this._onNotif(source, notif));
        this._sourceConns.set(source, id);
        source.connect('destroy', () => {
            this._sourceConns.delete(source);
        });
    }

    _onNotif(source, notif) {
        this.emit('peek', source, notif);

        const ttl = this._settings.get_int('notif-auto-dismiss');
        if (ttl <= 0) return;
        if (this._isResident(notif)) return;

        const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, ttl, () => {
            this._pendingDismiss.delete(notif);
            try {
                if (notif && !notif.destroyed) notif.destroy?.();
            } catch (e) { logError(e, 'mertnotch:notifications'); }
            return GLib.SOURCE_REMOVE;
        });
        this._pendingDismiss.set(notif, timer);

        try {
            notif.connect('destroy', () => {
                const t = this._pendingDismiss.get(notif);
                if (t) { GLib.source_remove(t); this._pendingDismiss.delete(notif); }
            });
        } catch (_) {}
    }

    _isResident(notif) {
        if (!notif) return false;
        if (notif.resident) return true;
        if (notif.urgency === 2) return true;
        if (notif.isTransient === false && notif.acknowledged === false && notif.urgency === 2) return true;
        return false;
    }
});
