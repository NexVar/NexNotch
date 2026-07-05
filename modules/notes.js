import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DEFAULT_NOTES_DIR = '/home/mert/Yazılım/MertProjeler/NexNotchNotes';

function _slug(text) {
    const s = (text || '').trim().toLowerCase()
        .replace(/[^a-z0-9ığüşöçİĞÜŞÖÇ\s-]/gi, '')
        .replace(/\s+/g, '-')
        .slice(0, 48)
        .replace(/^-+|-+$/g, '');
    return s || 'note';
}

function _dayDirName(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${String(d.getFullYear()).slice(-2)}`;
}

export const Notes = GObject.registerClass({
    Signals: {
        'updated': {},
    },
}, class Notes extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._grab = null;
        this._grabActor = null;
        this._focusCount = 0;
        /* Drafts persist on the instance (not in render()'s local scope) so
           switching tabs away and back doesn't lose in-progress typing —
           render() is called fresh every time the Notes tab becomes active. */
        this._drafts = [{id: this._newId(), title: '', body: '', filePath: null, saveTimer: 0}];
    }

    setGrabActor(actor) { this._grabActor = actor; }

    start() {}
    stop() {
        this._releaseGrab();
        for (const d of this._drafts) {
            if (d.saveTimer) { GLib.source_remove(d.saveTimer); d.saveTimer = 0; }
            this._saveDraft(d);
        }
    }
    destroy() { this.stop(); }

    _newId() { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

    _notesDir() {
        return this._settings.get_string('notes-folder') || DEFAULT_NOTES_DIR;
    }

    _pushGrab() {
        if (this._grab || !this._grabActor) return;
        try {
            this._grab = Main.pushModal(this._grabActor, {
                actionMode: 1 << 1,  /* Shell.ActionMode.NORMAL */
            });
        } catch (_) {}
    }

    _releaseGrab() {
        if (!this._grab) return;
        try {
            if (typeof Main.popModal === 'function') Main.popModal(this._grab);
        } catch (_) {}
        this._grab = null;
        if (this._grabActor) this._grabActor._notesFocused = false;
    }

    /* Any of N entries can hold focus at once; only release the modal grab
       once none of them do (checked on idle so tabbing between two of our
       own entries doesn't cause a spurious release). */
    _onEntryFocusIn() {
        this._focusCount++;
        this._pushGrab();
        if (this._grabActor) this._grabActor._notesFocused = true;
    }

    _onEntryFocusOut() {
        this._focusCount = Math.max(0, this._focusCount - 1);
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._focusCount <= 0) {
                this._releaseGrab();
                if (this._grabActor) this._grabActor._notesFocused = false;
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    render() {
        const box = new St.BoxLayout({style_class: 'nexnotch-notes', vertical: true, x_expand: true, y_expand: true});

        const header = new St.BoxLayout({style_class: 'nexnotch-notes-header', x_expand: true});
        header.add_child(new St.Label({text: 'Notes', style_class: 'nexnotch-notes-heading', x_expand: true}));
        const newBtn = new St.Button({style_class: 'nexnotch-notes-new', label: '+ New', can_focus: true});
        newBtn.connect('clicked', () => {
            this._drafts.push({id: this._newId(), title: '', body: '', filePath: null, saveTimer: 0});
            this.emit('updated');
        });
        header.add_child(newBtn);
        box.add_child(header);

        const scroll = new St.ScrollView({style_class: 'nexnotch-notes-scroll', x_expand: true, y_expand: true});
        const list = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'nexnotch-notes-list'});
        for (const draft of this._drafts) list.add_child(this._draftCard(draft));
        scroll.set_child(list);
        box.add_child(scroll);

        return box;
    }

    _draftCard(draft) {
        const card = new St.BoxLayout({style_class: 'nexnotch-notes-card', vertical: true, x_expand: true});

        const titleEntry = new St.Entry({
            style_class: 'nexnotch-notes-title-entry',
            hint_text: 'Title (optional)',
            x_expand: true,
            can_focus: true,
        });
        titleEntry.set_text(draft.title);
        const titleText = titleEntry.get_clutter_text();
        titleText.connect('text-changed', () => {
            draft.title = titleText.get_text();
            this._debouncedSave(draft);
        });
        titleText.connect('key-focus-in', () => this._onEntryFocusIn());
        titleText.connect('key-focus-out', () => this._onEntryFocusOut());
        card.add_child(titleEntry);

        const bodyEntry = new St.Entry({
            style_class: 'nexnotch-notes-entry',
            hint_text: 'Type your note…',
            x_expand: true,
            y_expand: true,
            can_focus: true,
        });
        const bodyText = bodyEntry.get_clutter_text();
        bodyText.set_single_line_mode(false);
        bodyText.set_activatable(false);
        bodyText.set_editable(true);
        bodyText.set_line_wrap(true);
        bodyText.set_line_wrap_mode(2);
        bodyText.set_selectable(true);
        bodyText.set_text(draft.body);
        bodyText.connect('text-changed', () => {
            draft.body = bodyText.get_text();
            this._debouncedSave(draft);
        });
        bodyText.connect('key-focus-in', () => this._onEntryFocusIn());
        bodyText.connect('key-focus-out', () => this._onEntryFocusOut());
        bodyText.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._releaseGrab();
                try { global.stage.set_key_focus(null); } catch (_) {}
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        card.add_child(bodyEntry);

        const footer = new St.BoxLayout({style_class: 'nexnotch-notes-footer'});
        const status = new St.Label({
            text: draft.filePath ? `Saved → ${draft.filePath.replace(GLib.get_home_dir(), '~')}` : 'Not saved yet',
            style_class: 'nexnotch-notes-info',
            x_expand: true,
        });
        footer.add_child(status);
        const delBtn = new St.Button({style_class: 'nexnotch-notes-clear', label: 'Delete', can_focus: true});
        delBtn.connect('clicked', () => {
            if (draft.saveTimer) GLib.source_remove(draft.saveTimer);
            if (draft.filePath) { try { Gio.File.new_for_path(draft.filePath).delete(null); } catch (_) {} }
            this._drafts = this._drafts.filter(d => d.id !== draft.id);
            if (this._drafts.length === 0) this._drafts.push({id: this._newId(), title: '', body: '', filePath: null, saveTimer: 0});
            this.emit('updated');
        });
        footer.add_child(delBtn);
        card.add_child(footer);

        return card;
    }

    _debouncedSave(draft) {
        if (draft.saveTimer) GLib.source_remove(draft.saveTimer);
        draft.saveTimer = GLib.timeout_add(GLib.PRIORITY_LOW, 800, () => {
            draft.saveTimer = 0;
            this._saveDraft(draft);
            return GLib.SOURCE_REMOVE;
        });
    }

    _saveDraft(draft) {
        if (!draft.title.trim() && !draft.body.trim()) return;
        try {
            const dayDir = GLib.build_filenamev([this._notesDir(), _dayDirName(new Date())]);
            GLib.mkdir_with_parents(dayDir, 0o755);
            const base = _slug(draft.title || draft.body);
            let target = GLib.build_filenamev([dayDir, `${base}.md`]);
            /* if this draft already has a file under a different name (title
               changed since last save), move it instead of leaving orphans */
            if (draft.filePath && draft.filePath !== target) {
                try { Gio.File.new_for_path(draft.filePath).delete(null); } catch (_) {}
            } else if (!draft.filePath) {
                /* avoid clobbering an unrelated existing file with the same slug */
                let i = 1;
                while (GLib.file_test(target, GLib.FileTest.EXISTS) && draft.filePath !== target) {
                    target = GLib.build_filenamev([dayDir, `${base}-${i}.md`]);
                    i++;
                }
            }
            const content = draft.title.trim() ? `# ${draft.title.trim()}\n\n${draft.body}` : draft.body;
            GLib.file_set_contents(target, content);
            draft.filePath = target;
        } catch (e) { logError(e, 'nexnotch:notes:save'); }
    }
});
