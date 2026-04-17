import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Notch} from './notch.js';

export default class MertNotchExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._notch = new Notch(this);

        const centerBox = Main.panel._centerBox;
        centerBox.insert_child_at_index(this._notch, 0);

        this._notch.start();
    }

    disable() {
        if (this._notch) {
            this._notch.stop();
            this._notch.get_parent()?.remove_child(this._notch);
            this._notch.destroy();
            this._notch = null;
        }
        this._settings = null;
    }
}
