import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Notch} from './notch.js';

export default class MertNotchExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        /* Ensure Evolution Data Server source registry is running. On this
           Fedora setup D-Bus service-file activation of
           org.gnome.evolution.dataserver.Sources5 doesn't happen at login,
           so Calendar and Tasks arrive empty. Spawning it here is idempotent
           — if it's already running the second instance exits immediately. */
        try {
            Gio.Subprocess.new(
                ['/usr/libexec/evolution-source-registry'],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
            );
        } catch (_) {}

        this._notch = new Notch(this);

        /* Mount the notch into the top chrome layer — OUTSIDE the panel's
           actor tree. This keeps any Shell.BlurEffect that blur-my-shell
           attaches to the panel from bleeding through the notch. */
        Main.layoutManager.addTopChrome(this._notch, {
            trackFullscreen: true,
            affectsStruts: false,
            affectsInputRegion: true,
        });

        this._reposition = () => this._positionNotch();
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', this._reposition);
        this._panelAllocId = Main.panel.connect('notify::allocation', this._reposition);
        this._notchAllocId = this._notch.connect('notify::allocation', this._reposition);
        this._positionNotch();

        this._notch.start();
    }

    _positionNotch() {
        if (!this._notch) return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        const [, natW] = this._notch.get_preferred_width(-1);
        const [, natH] = this._notch.get_preferred_height(natW);
        const w = natW || this._notch.width || 240;
        const x = monitor.x + Math.floor((monitor.width - w) / 2);
        const y = monitor.y;
        this._notch.set_position(x, y);
    }

    disable() {
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        if (this._panelAllocId) {
            try { Main.panel.disconnect(this._panelAllocId); } catch (_) {}
            this._panelAllocId = 0;
        }
        if (this._notchAllocId) {
            try { this._notch?.disconnect(this._notchAllocId); } catch (_) {}
            this._notchAllocId = 0;
        }
        if (this._notch) {
            this._notch.stop();
            try { Main.layoutManager.removeChrome(this._notch); } catch (_) {}
            this._notch.destroy();
            this._notch = null;
        }
        this._reposition = null;
        this._settings = null;
    }
}
