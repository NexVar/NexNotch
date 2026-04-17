import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';

import {getAccessToken, listGoogleAccounts} from './goa.js';

const SHELF_DIR  = GLib.build_filenamev([GLib.get_user_cache_dir(), 'mertnotch', 'shelf']);
const DRIVE_API  = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

export const DropShelf = GObject.registerClass({
    Signals: {
        'count-changed':    {param_types: [GObject.TYPE_INT]},
        'request-add-file': {},
    },
}, class DropShelf extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._items = [];
        this._soup = new Soup.Session();
        this._soup.set_timeout(60);
        GLib.mkdir_with_parents(SHELF_DIR, 0o755);
    }

    start() {
        this._loadExisting();
    }

    stop() {}
    destroy() { this.stop(); }

    _loadExisting() {
        this._items = [];
        try {
            const dir = Gio.File.new_for_path(SHELF_DIR);
            const iter = dir.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = iter.next_file(null))) {
                this._items.push({
                    name: info.get_display_name(),
                    path: GLib.build_filenamev([SHELF_DIR, info.get_name()]),
                    size: info.get_size(),
                    state: 'idle',
                });
            }
        } catch (_) {}
        this.emit('count-changed', this._items.length);
    }

    addURI(uri) {
        try {
            const file = Gio.File.new_for_uri(uri);
            if (!file.query_exists(null)) return;
            const name = file.get_basename();
            const dest = Gio.File.new_for_path(GLib.build_filenamev([SHELF_DIR, this._safeName(name)]));
            file.copy(dest, Gio.FileCopyFlags.OVERWRITE, null, null);
            const info = dest.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
            const item = {name, path: dest.get_path(), size: info.get_size(), state: 'idle'};
            this._items.push(item);
            this.emit('count-changed', this._items.length);
            this._dispatch(item);
        } catch (e) { logError(e, 'mertnotch:dropshelf:addURI'); }
    }

    _safeName(name) {
        if (!GLib.file_test(GLib.build_filenamev([SHELF_DIR, name]), GLib.FileTest.EXISTS)) return name;
        const dot = name.lastIndexOf('.');
        const base = dot > 0 ? name.slice(0, dot) : name;
        const ext  = dot > 0 ? name.slice(dot)    : '';
        const ts = Math.floor(Date.now() / 1000);
        return `${base}-${ts}${ext}`;
    }

    _dispatch(item) {
        const dest = this._settings.get_string('dropshelf-destination');
        const folder = this._settings.get_string('dropshelf-folder');
        const acct = this._settings.get_string('dropshelf-account');
        const folderId = this._settings.get_string('dropshelf-drive-folder') || 'root';
        const deleteAfter = this._settings.get_boolean('dropshelf-delete-after');
        if (dest === 'local') return;
        if (dest === 'folder') {
            if (!folder) { logError(new Error('No destination folder configured'), 'mertnotch:dropshelf'); return; }
            this._copyToFolder(item, folder, deleteAfter);
        }
        if (dest === 'drive-oauth' || dest === 'local+drive-oauth') {
            if (!acct) { logError(new Error('No Drive account configured'), 'mertnotch:dropshelf'); return; }
            this._uploadToDrive(item, acct, folderId, deleteAfter || dest === 'drive-oauth');
        }
    }

    _copyToFolder(item, folderPath, deleteAfter) {
        item.state = 'uploading';
        this.emit('count-changed', this._items.length);
        try {
            const destDir = Gio.File.new_for_path(folderPath);
            if (!destDir.query_exists(null)) {
                try { destDir.make_directory_with_parents(null); } catch (_) {}
            }
            const src = Gio.File.new_for_path(item.path);
            const target = destDir.get_child(this._safeBasename(destDir, item.name));
            src.copy_async(target, Gio.FileCopyFlags.NONE, GLib.PRIORITY_DEFAULT, null, null, (_, res) => {
                try {
                    src.copy_finish(res);
                    item.state = 'uploaded';
                    if (deleteAfter) {
                        try { src.delete(null); } catch (_) {}
                        this._items = this._items.filter(i => i.path !== item.path);
                    }
                    this.emit('count-changed', this._items.length);
                } catch (e) {
                    item.state = 'error';
                    item.error = String(e?.message ?? e);
                    this.emit('count-changed', this._items.length);
                    logError(e, 'mertnotch:dropshelf:folder-copy');
                }
            });
        } catch (e) {
            item.state = 'error';
            item.error = String(e?.message ?? e);
            this.emit('count-changed', this._items.length);
            logError(e, 'mertnotch:dropshelf:folder-copy-setup');
        }
    }

    _safeBasename(dir, name) {
        let n = name;
        let i = 0;
        while (dir.get_child(n).query_exists(null) && i < 100) {
            i++;
            const dot = name.lastIndexOf('.');
            const base = dot > 0 ? name.slice(0, dot) : name;
            const ext  = dot > 0 ? name.slice(dot) : '';
            n = `${base}-${i}${ext}`;
        }
        return n;
    }

    async _uploadToDrive(item, accountEmail, folderId, deleteAfter) {
        item.state = 'uploading';
        this.emit('count-changed', this._items.length);
        try {
            const token = await getAccessToken(accountEmail);
            const data = GLib.file_get_contents(item.path)[1];
            const metadata = JSON.stringify({
                name: item.name,
                parents: [folderId],
            });
            const boundary = `----mertnotch${Math.random().toString(36).slice(2)}`;
            const head = new TextEncoder().encode(
                `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
                `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`
            );
            const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
            const body = new Uint8Array(head.length + data.length + tail.length);
            body.set(head, 0);
            body.set(data, head.length);
            body.set(tail, head.length + data.length);

            const msg = Soup.Message.new('POST', DRIVE_API);
            msg.request_headers.append('Authorization', `Bearer ${token}`);
            msg.request_headers.append('Content-Type', `multipart/related; boundary=${boundary}`);
            msg.set_request_body_from_bytes(null, GLib.Bytes.new(body));

            const result = await new Promise((resolve, reject) => {
                this._soup.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                    try {
                        const bytes = session.send_and_read_finish(res);
                        const text = new TextDecoder().decode(bytes.get_data());
                        if (msg.status_code >= 200 && msg.status_code < 300) resolve(text);
                        else reject(new Error(`Drive upload ${msg.status_code}: ${text}`));
                    } catch (e) { reject(e); }
                });
            });

            item.state = 'uploaded';
            if (deleteAfter) {
                try { Gio.File.new_for_path(item.path).delete(null); } catch (_) {}
                this._items = this._items.filter(i => i.path !== item.path);
            }
            this.emit('count-changed', this._items.length);
        } catch (e) {
            item.state = 'error';
            item.error = String(e?.message ?? e);
            logError(e, 'mertnotch:drive-upload');
            this.emit('count-changed', this._items.length);
        }
    }

    removeItem(path) {
        try { Gio.File.new_for_path(path).delete(null); } catch (_) {}
        this._items = this._items.filter(i => i.path !== path);
        this.emit('count-changed', this._items.length);
    }

    retryItem(path) {
        const item = this._items.find(i => i.path === path);
        if (item) this._dispatch(item);
    }

    render() {
        const box = new St.BoxLayout({style_class: 'mertnotch-shelf', vertical: true, x_expand: true, y_expand: true});
        const dest = this._settings.get_string('dropshelf-destination');
        const acct = this._settings.get_string('dropshelf-account');
        const header = new St.BoxLayout({style_class: 'mertnotch-shelf-header'});
        header.add_child(new St.Label({
            text: `→ ${this._destLabel(dest, acct)}`,
            style_class: 'mertnotch-shelf-dest',
            x_expand: true,
        }));
        const addBtn = new St.Button({style_class: 'mertnotch-shelf-add', label: '+ Add'});
        addBtn.connect('clicked', () => this.emit('request-add-file'));
        header.add_child(addBtn);
        const openBtn = new St.Button({style_class: 'mertnotch-shelf-open', label: 'Open ↗'});
        openBtn.connect('clicked', () => {
            Gio.AppInfo.launch_default_for_uri(
                Gio.File.new_for_path(SHELF_DIR).get_uri(), null);
        });
        header.add_child(openBtn);
        box.add_child(header);

        if (this._items.length === 0) {
            box.add_child(new St.Label({
                text: 'Drag files onto the notch to upload',
                style_class: 'mertnotch-empty',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return box;
        }
        for (const it of this._items) {
            const row = new St.BoxLayout({style_class: 'mertnotch-shelf-row'});
            const nameLabel = new St.Label({text: it.name, style_class: 'mertnotch-shelf-name', x_expand: true});
            if (it.state === 'uploading') nameLabel.add_style_class_name('uploading');
            if (it.state === 'error')     nameLabel.add_style_class_name('error');
            if (it.state === 'uploaded')  nameLabel.add_style_class_name('uploaded');
            row.add_child(nameLabel);
            row.add_child(new St.Label({text: this._stateLabel(it.state), style_class: 'mertnotch-shelf-state'}));
            row.add_child(new St.Label({text: this._sizeFmt(it.size), style_class: 'mertnotch-shelf-size'}));
            if (it.state === 'error') {
                const retry = new St.Button({style_class: 'mertnotch-shelf-retry', label: '↻'});
                retry.connect('clicked', () => this.retryItem(it.path));
                row.add_child(retry);
            }
            const rm = new St.Button({style_class: 'mertnotch-shelf-rm', label: '×'});
            rm.connect('clicked', () => this.removeItem(it.path));
            row.add_child(rm);
            box.add_child(row);
        }
        return box;
    }

    _destLabel(dest, acct) {
        if (dest === 'local') return 'Local shelf only';
        if (dest === 'folder') {
            const f = this._settings.get_string('dropshelf-folder');
            const short = f ? f.replace(GLib.get_home_dir(), '~') : 'unset';
            return `→ ${short}`;
        }
        if (dest === 'drive-oauth') return `Drive OAuth (${acct || 'no account'})`;
        if (dest === 'local+drive-oauth') return `Local + Drive OAuth (${acct || 'no account'})`;
        return dest;
    }

    _stateLabel(state) {
        return {idle: '', uploading: 'uploading…', uploaded: 'uploaded ✓', error: 'error'}[state] ?? '';
    }

    _sizeFmt(b) {
        if (b < 1024)        return `${b} B`;
        if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
        return `${(b / 1024 / 1024).toFixed(1)} MB`;
    }
});
