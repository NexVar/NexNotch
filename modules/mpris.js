import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';

const PLAYER_IFACE_XML = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <property name="Identity"      type="s" access="read"/>
    <property name="DesktopEntry"  type="s" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata"       type="a{sv}" access="read"/>
    <property name="CanGoNext"      type="b" access="read"/>
    <property name="CanGoPrevious"  type="b" access="read"/>
    <property name="CanPlay"        type="b" access="read"/>
    <property name="CanPause"       type="b" access="read"/>
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Play"/>
    <method name="Pause"/>
    <method name="Stop"/>
  </interface>
</node>`;

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PLAYER_IFACE_XML);

function _unwrap(v) {
    return (v && typeof v.deep_unpack === 'function') ? v.deep_unpack() : v;
}

function _extractMeta(metadata) {
    if (!metadata) return {};
    const get = (key) => {
        const v = metadata[key];
        if (!v) return null;
        return _unwrap(v);
    };
    const artist = get('xesam:artist');
    return {
        title:  get('xesam:title')  ?? '',
        artist: Array.isArray(artist) ? artist.join(', ') : (artist ?? ''),
        album:  get('xesam:album')  ?? '',
        artUrl: get('mpris:artUrl') ?? '',
        length: get('mpris:length') ?? 0,
    };
}

export const MprisWatcher = GObject.registerClass({
    Signals: {
        'changed': {param_types: [GObject.TYPE_JSOBJECT]},
    },
}, class MprisWatcher extends GObject.Object {
    _init() {
        super._init();
        this._watchIds = new Map();
        this._players  = new Map();
        this._active   = null;
    }

    start() {
        this._stopped = false;
        this._nameOwnerId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,
            Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith(MPRIS_PREFIX)) return;
                if (newOwner && !oldOwner) this._addPlayer(name);
                if (oldOwner && !newOwner) this._removePlayer(name);
            });
        this._listExistingPlayers().catch(e => logError(e, 'mertnotch:mpris'));
    }

    stop() {
        this._stopped = true;
        if (this._nameOwnerId) {
            try { Gio.DBus.session.signal_unsubscribe(this._nameOwnerId); } catch (_) {}
            this._nameOwnerId = 0;
        }
        for (const [, proxy] of this._players) {
            if (proxy._propChangedId) {
                try { proxy.disconnect(proxy._propChangedId); } catch (_) {}
            }
        }
        this._players.clear();
        this._active = null;
    }

    destroy() { this.stop(); }

    async _listExistingPlayers() {
        const reply = await new Promise((resolve, reject) => {
            Gio.DBus.session.call(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'ListNames',
                null, null,
                Gio.DBusCallFlags.NONE,
                -1, null,
                (_, res) => {
                    try { resolve(Gio.DBus.session.call_finish(res)); }
                    catch (e) { reject(e); }
                });
        });
        const [names] = reply.deepUnpack();
        for (const n of names) if (n.startsWith(MPRIS_PREFIX)) this._addPlayer(n);
    }

    _addPlayer(busName) {
        if (this._players.has(busName)) return;
        try {
            const proxy = PlayerProxy(Gio.DBus.session, busName, '/org/mpris/MediaPlayer2');
            proxy._propChangedId = proxy.connect('g-properties-changed', () => {
                if (this._stopped) return;
                this._recompute();
            });
            this._players.set(busName, proxy);
            this._recompute();
        } catch (e) { logError(e, 'mertnotch:mpris:add'); }
    }

    _removePlayer(busName) {
        const proxy = this._players.get(busName);
        if (!proxy) return;
        try { if (proxy._propChangedId) proxy.disconnect(proxy._propChangedId); } catch (_) {}
        this._players.delete(busName);
        this._recompute();
    }

    _recompute() {
        let best = null;
        for (const [name, proxy] of this._players) {
            try {
                const status = proxy.PlaybackStatus;
                if (status === 'Playing') { best = {name, proxy, status}; break; }
                if (!best && status === 'Paused') best = {name, proxy, status};
            } catch (_) {}
        }
        if (!best) {
            this._active = null;
            this.emit('changed', {playing: false, paused: false});
            return;
        }
        let iconName = 'audio-x-generic-symbolic';
        try {
            const desktop = best.proxy.DesktopEntry;
            if (desktop) iconName = desktop;
        } catch (_) {}
        let meta = {};
        try { meta = _extractMeta(best.proxy.Metadata); } catch (_) {}
        let canNext = true, canPrev = true, canPlay = true, canPause = true;
        try { canNext = best.proxy.CanGoNext !== false; } catch (_) {}
        try { canPrev = best.proxy.CanGoPrevious !== false; } catch (_) {}
        try { canPlay = best.proxy.CanPlay !== false; } catch (_) {}
        try { canPause = best.proxy.CanPause !== false; } catch (_) {}
        this._active = best;
        this.emit('changed', {
            playing: best.status === 'Playing',
            paused:  best.status === 'Paused',
            icon: iconName,
            bus: best.name,
            title:  meta.title,
            artist: meta.artist,
            album:  meta.album,
            artUrl: meta.artUrl,
            canNext, canPrev, canPlay, canPause,
        });
    }

    isActive() { return !!this._active; }

    playPause() { this._callActive('PlayPauseRemote'); }
    next()      { this._callActive('NextRemote'); }
    previous()  { this._callActive('PreviousRemote'); }

    _callActive(method) {
        if (!this._active?.proxy) return;
        try { this._active.proxy[method](() => {}); } catch (e) { logError(e, 'mertnotch:mpris:call'); }
    }
});
