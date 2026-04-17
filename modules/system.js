import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

export const SystemMonitor = GObject.registerClass({
    Signals: {
        'updated': {param_types: [GObject.TYPE_JSOBJECT]},
    },
}, class SystemMonitor extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._timer = 0;
        this._lastCpu = null;
        this._lastNet = null;
        this._lastNetTime = 0;
        this._lastDisk = null;
        this._lastDiskTime = 0;
        this._cpuCores = GLib.get_num_processors();
        this._thermalZones = this._findThermalZones();
        this._hwmonInputs = this._findHwmonInputs();
        this._batteryPath = this._findBattery();
        this._stats = this._emptyStats();
    }

    _emptyStats() {
        return {
            cpu: 0, ram: 0, swap: 0,
            net_rx: 0, net_tx: 0,
            disk_r: 0, disk_w: 0,
            temp: 0, temp_cpu: 0,
            load: [0, 0, 0],
            uptime: 0,
            battery: null,
        };
    }

    start() {
        this._tick();
        const interval = Math.max(1, this._settings.get_int('poll-interval')) * 1000;
        this._timer = GLib.timeout_add(GLib.PRIORITY_LOW, interval, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        this._settingsSig = this._settings.connect('changed::poll-interval', () => this._restartTimer());
    }

    _restartTimer() {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = 0; }
        const interval = Math.max(1, this._settings.get_int('poll-interval')) * 1000;
        this._timer = GLib.timeout_add(GLib.PRIORITY_LOW, interval, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = 0; }
        if (this._settingsSig) { this._settings.disconnect(this._settingsSig); this._settingsSig = 0; }
    }

    destroy() { this.stop(); }

    _tick() {
        try {
            this._stats.cpu       = this._cpuUsage();
            const mem             = this._memUsage();
            this._stats.ram       = mem.ram;
            this._stats.swap      = mem.swap;
            const net             = this._netRate();
            this._stats.net_rx    = net.rx; this._stats.net_tx = net.tx;
            const disk            = this._diskRate();
            this._stats.disk_r    = disk.r; this._stats.disk_w = disk.w;
            this._stats.temp      = this._temperature();
            this._stats.load      = this._loadAvg();
            this._stats.uptime    = this._uptime();
            this._stats.battery   = this._battery();
            this.emit('updated', this._stats);
        } catch (e) { logError(e, 'mertnotch:system'); }
    }

    _readFile(path) {
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            if (!ok) return '';
            return new TextDecoder().decode(bytes);
        } catch (_) { return ''; }
    }

    _cpuUsage() {
        const line = this._readFile('/proc/stat').split('\n')[0];
        const p = line.split(/\s+/).slice(1).map(Number);
        const idle = p[3] + (p[4] ?? 0);
        const total = p.reduce((a, b) => a + b, 0);
        if (!this._lastCpu) { this._lastCpu = {idle, total}; return 0; }
        const dIdle = idle - this._lastCpu.idle;
        const dTotal = total - this._lastCpu.total;
        this._lastCpu = {idle, total};
        return dTotal > 0 ? (1 - dIdle / dTotal) * 100 : 0;
    }

    _memUsage() {
        const text = this._readFile('/proc/meminfo');
        const get = k => {
            const m = text.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'));
            return m ? Number(m[1]) : 0;
        };
        const memTotal = get('MemTotal');
        const memAvail = get('MemAvailable');
        const swapTotal = get('SwapTotal');
        const swapFree  = get('SwapFree');
        return {
            ram:  memTotal  > 0 ? ((memTotal  - memAvail) / memTotal)  * 100 : 0,
            swap: swapTotal > 0 ? ((swapTotal - swapFree) / swapTotal) * 100 : 0,
        };
    }

    _netRate() {
        const lines = this._readFile('/proc/net/dev').split('\n').slice(2);
        let rx = 0, tx = 0;
        for (const line of lines) {
            const m = line.trim().match(/^([^:]+):\s+(.+)$/);
            if (!m) continue;
            const iface = m[1].trim();
            if (iface === 'lo' || iface.startsWith('docker') || iface.startsWith('veth') ||
                iface.startsWith('br-') || iface.startsWith('virbr') || iface.startsWith('tun')) continue;
            const cols = m[2].split(/\s+/).map(Number);
            rx += cols[0]; tx += cols[8];
        }
        const now = GLib.get_monotonic_time() / 1000;
        if (!this._lastNet) { this._lastNet = {rx, tx}; this._lastNetTime = now; return {rx: 0, tx: 0}; }
        const dt = (now - this._lastNetTime) / 1000;
        const drx = rx - this._lastNet.rx;
        const dtx = tx - this._lastNet.tx;
        this._lastNet = {rx, tx}; this._lastNetTime = now;
        return dt > 0 ? {rx: (drx / 1024) / dt, tx: (dtx / 1024) / dt} : {rx: 0, tx: 0};
    }

    _diskRate() {
        const lines = this._readFile('/proc/diskstats').split('\n');
        let r = 0, w = 0;
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 14) continue;
            const name = parts[2];
            if (/^(loop|ram|dm-|sr)/.test(name)) continue;
            if (/\d+$/.test(name) && !/^nvme\d+n\d+$/.test(name)) continue;
            r += Number(parts[5]);
            w += Number(parts[9]);
        }
        const now = GLib.get_monotonic_time() / 1000;
        if (!this._lastDisk) { this._lastDisk = {r, w}; this._lastDiskTime = now; return {r: 0, w: 0}; }
        const dt = (now - this._lastDiskTime) / 1000;
        const dr = (r - this._lastDisk.r) * 512 / 1024;
        const dw = (w - this._lastDisk.w) * 512 / 1024;
        this._lastDisk = {r, w}; this._lastDiskTime = now;
        return dt > 0 ? {r: dr / dt, w: dw / dt} : {r: 0, w: 0};
    }

    _findThermalZones() {
        const zones = [];
        try {
            const dir = Gio.File.new_for_path('/sys/class/thermal');
            const iter = dir.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = iter.next_file(null))) {
                const n = info.get_name();
                if (n.startsWith('thermal_zone')) zones.push(`/sys/class/thermal/${n}/temp`);
            }
        } catch (_) {}
        return zones;
    }

    _findHwmonInputs() {
        const inputs = [];
        try {
            const dir = Gio.File.new_for_path('/sys/class/hwmon');
            const iter = dir.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = iter.next_file(null))) {
                const base = `/sys/class/hwmon/${info.get_name()}`;
                const nameText = this._readFile(`${base}/name`).trim();
                const subdir = Gio.File.new_for_path(base);
                const subIter = subdir.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
                let sub;
                while ((sub = subIter.next_file(null))) {
                    const n = sub.get_name();
                    if (/^temp\d+_input$/.test(n)) inputs.push({path: `${base}/${n}`, name: nameText});
                }
            }
        } catch (_) {}
        return inputs;
    }

    _temperature() {
        let max = 0;
        for (const p of this._thermalZones) {
            const v = Number(this._readFile(p).trim());
            if (v > max) max = v;
        }
        for (const h of this._hwmonInputs) {
            const v = Number(this._readFile(h.path).trim());
            if (v > max) max = v;
        }
        return max / 1000;
    }

    _loadAvg() {
        return this._readFile('/proc/loadavg').trim().split(' ').slice(0, 3).map(Number);
    }

    _uptime() {
        const text = this._readFile('/proc/uptime').trim().split(' ')[0];
        return Number(text);
    }

    _findBattery() {
        try {
            const dir = Gio.File.new_for_path('/sys/class/power_supply');
            const iter = dir.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = iter.next_file(null))) {
                const n = info.get_name();
                const type = this._readFile(`/sys/class/power_supply/${n}/type`).trim();
                if (type === 'Battery') return `/sys/class/power_supply/${n}`;
            }
        } catch (_) {}
        return null;
    }

    _battery() {
        if (!this._batteryPath) return null;
        const capacity = Number(this._readFile(`${this._batteryPath}/capacity`).trim());
        const status = this._readFile(`${this._batteryPath}/status`).trim();
        return {capacity, status};
    }

    render() {
        const s = this._stats;
        const box = new St.BoxLayout({style_class: 'mertnotch-sys', vertical: true, x_expand: true, y_expand: true});
        const grid = new Clutter.GridLayout();
        const content = new St.Widget({layout_manager: grid, x_expand: true, style_class: 'mertnotch-sys-grid'});
        let row = 0;
        const add = (label, value, barPct) => {
            const lbl = new St.Label({text: label, style_class: 'mertnotch-sys-label', x_expand: true});
            const val = new St.Label({text: value, style_class: 'mertnotch-sys-value'});
            grid.attach(lbl, 0, row, 1, 1);
            grid.attach(val, 1, row, 1, 1);
            if (barPct !== undefined) {
                const bar = new St.Widget({style_class: 'mertnotch-bar', height: 3, x_expand: true});
                const fill = new St.Widget({style_class: 'mertnotch-bar-fill', height: 3});
                fill.set_width(Math.max(2, Math.floor(Math.min(100, barPct) * 3)));
                if (barPct > 85) fill.add_style_class_name('danger');
                else if (barPct > 65) fill.add_style_class_name('warn');
                bar.add_child(fill);
                grid.attach(bar, 0, row + 1, 2, 1);
                row += 2;
            } else row += 1;
        };

        add('CPU',       `${s.cpu.toFixed(0)}%`, s.cpu);
        add('Memory',    `${s.ram.toFixed(0)}%`, s.ram);
        if (s.swap > 0) add('Swap', `${s.swap.toFixed(0)}%`, s.swap);
        add('Net ↓',     `${this._kbFmt(s.net_rx)}`);
        add('Net ↑',     `${this._kbFmt(s.net_tx)}`);
        add('Disk ↓',    `${this._kbFmt(s.disk_r)}`);
        add('Disk ↑',    `${this._kbFmt(s.disk_w)}`);
        if (s.temp > 0) add('Temp',  `${s.temp.toFixed(0)}°C`);
        add('Load',      s.load.map(x => x.toFixed(2)).join(' '));
        add('Uptime',    this._upFmt(s.uptime));
        if (s.battery) add('Battery', `${s.battery.capacity}% ${s.battery.status}`);

        box.add_child(content);
        return box;
    }

    _kbFmt(kb) {
        if (kb < 1)        return `${(kb * 1024).toFixed(0)} B/s`;
        if (kb < 1024)     return `${kb.toFixed(1)} KB/s`;
        return `${(kb / 1024).toFixed(2)} MB/s`;
    }

    _upFmt(sec) {
        const d = Math.floor(sec / 86400);
        const h = Math.floor((sec % 86400) / 3600);
        const m = Math.floor((sec % 3600) / 60);
        if (d > 0) return `${d}d ${h}h`;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }
});
