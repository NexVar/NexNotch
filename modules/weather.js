import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';

export const Weather = GObject.registerClass({
    Signals: {
        'updated': {},
    },
}, class Weather extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._soup = new Soup.Session();
        this._soup.set_timeout(10);
        this._data = null;
        this._data2 = null;
        this._active = 1;
        this._timer = 0;
        this._lastFetch = 0;
    }

    start() {
        this._fetchAll();
        this._restartTimer();
        this._settingsSig  = this._settings.connect('changed::weather-location',   () => this._fetchAll());
        this._settingsSig2 = this._settings.connect('changed::weather-unit',       () => this._fetchAll());
        this._settingsSig3 = this._settings.connect('changed::weather-location-2', () => this._fetchAll());
        this._settingsSig4 = this._settings.connect('changed::weather-refresh',    () => this._restartTimer());
    }

    _fetchAll() {
        this._fetch(1);
        const loc2 = this._settings.get_string('weather-location-2');
        if (loc2 && loc2.trim()) this._fetch(2);
        else {
            this._data2 = null;
            /* If secondary was selected but just removed, fall back to primary */
            if (this._active === 2) this._active = 1;
            this.emit('updated');
        }
    }

    _restartTimer() {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = 0; }
        const minutes = Math.max(1, this._settings.get_int('weather-refresh'));
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, minutes * 60, () => {
            this._fetchAll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = 0; }
        if (this._settingsSig)  { this._settings.disconnect(this._settingsSig);  this._settingsSig = 0; }
        if (this._settingsSig2) { this._settings.disconnect(this._settingsSig2); this._settingsSig2 = 0; }
        if (this._settingsSig3) { this._settings.disconnect(this._settingsSig3); this._settingsSig3 = 0; }
        if (this._settingsSig4) { this._settings.disconnect(this._settingsSig4); this._settingsSig4 = 0; }
    }

    destroy() { this.stop(); }

    _fetch(slot) {
        const key = slot === 2 ? 'weather-location-2' : 'weather-location';
        const loc  = this._settings.get_string(key) || '';
        const unit = this._settings.get_string('weather-unit') === 'imperial' ? 'u' : 'm';
        const url  = `https://wttr.in/${encodeURIComponent(loc)}?format=j1`;
        const msg  = Soup.Message.new('GET', url);
        msg.request_headers.append('User-Agent', 'mertnotch/0.1');
        this._soup.send_and_read_async(msg, GLib.PRIORITY_LOW, null, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                const text = new TextDecoder().decode(bytes.get_data());
                if (msg.status_code < 200 || msg.status_code >= 300) {
                    this._lastError = `wttr.in ${msg.status_code}`;
                    this.emit('updated');
                    return;
                }
                let data;
                try { data = JSON.parse(text); }
                catch (_) {
                    this._lastError = 'wttr.in returned non-JSON (rate-limited?)';
                    this.emit('updated');
                    return;
                }
                data._unit = unit;
                if (slot === 2) this._data2 = data;
                else            this._data  = data;
                this._lastError = null;
                this._lastFetch = Date.now();
                this.emit('updated');
            } catch (e) {
                this._lastError = String(e?.message ?? e);
                logError(e, 'mertnotch:weather');
                this.emit('updated');
            }
        });
    }

    render() {
        const box = new St.BoxLayout({style_class: 'mertnotch-weather', vertical: true, x_expand: true, y_expand: true});

        /* error state — network failed or wttr.in 5xx */
        if (this._lastError && !this._data && !this._data2) {
            box.add_child(new St.Label({
                text: 'Weather unavailable',
                style_class: 'mertnotch-empty',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            box.add_child(new St.Label({
                text: this._lastError,
                style_class: 'mertnotch-empty',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return box;
        }

        /* location switcher if two configured */
        const loc2 = this._settings.get_string('weather-location-2');
        if (loc2 && loc2.trim()) {
            const switcher = new St.BoxLayout({style_class: 'mertnotch-weather-switcher', x_align: Clutter.ActorAlign.CENTER});
            const lbl1 = this._settings.get_string('weather-location-label') ||
                        (this._settings.get_string('weather-location') || 'Primary');
            const lbl2 = this._settings.get_string('weather-location-2-label') || loc2;
            for (const [slot, label] of [[1, lbl1], [2, lbl2]]) {
                const btn = new St.Button({
                    style_class: 'mertnotch-weather-tab' + (this._active === slot ? ' active' : ''),
                    label,
                });
                btn.connect('clicked', () => { this._active = slot; this.emit('updated'); });
                switcher.add_child(btn);
            }
            box.add_child(switcher);
        }

        const data = this._active === 2 ? this._data2 : this._data;
        if (!data) {
            box.add_child(new St.Label({
                text: 'Loading weather…',
                style_class: 'mertnotch-empty',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return box;
        }

        try {
            const cur   = data.current_condition?.[0];
            const area  = data.nearest_area?.[0]?.areaName?.[0]?.value ?? '—';
            const days  = data.weather ?? [];
            const unit  = data._unit ?? 'm';

            const header = new St.BoxLayout({style_class: 'mertnotch-weather-header'});
            const left = new St.BoxLayout({vertical: true, x_expand: true});
            left.add_child(new St.Label({text: area, style_class: 'mertnotch-weather-area'}));
            left.add_child(new St.Label({
                text: cur.weatherDesc?.[0]?.value ?? '',
                style_class: 'mertnotch-weather-desc',
            }));
            header.add_child(left);

            const temp = unit === 'u' ? `${cur.temp_F}°F` : `${cur.temp_C}°C`;
            header.add_child(new St.Label({text: temp, style_class: 'mertnotch-weather-temp'}));
            box.add_child(header);

            const meta = new St.BoxLayout({style_class: 'mertnotch-weather-meta', vertical: false});
            meta.add_child(this._metaCell('Feels', unit === 'u' ? `${cur.FeelsLikeF}°` : `${cur.FeelsLikeC}°`));
            meta.add_child(this._metaCell('Humidity', `${cur.humidity}%`));
            meta.add_child(this._metaCell('Wind', unit === 'u' ? `${cur.windspeedMiles} mph` : `${cur.windspeedKmph} km/h`));
            meta.add_child(this._metaCell('UV', cur.uvIndex));
            box.add_child(meta);

            const forecast = new St.BoxLayout({style_class: 'mertnotch-weather-forecast', vertical: false});
            for (const d of days.slice(0, 3)) {
                const cell = new St.BoxLayout({style_class: 'mertnotch-weather-day', vertical: true, x_expand: true});
                const day  = new Date(d.date).toLocaleDateString([], {weekday: 'short'});
                cell.add_child(new St.Label({text: day, style_class: 'mertnotch-weather-day-label'}));
                const range = unit === 'u' ? `${d.mintempF}° / ${d.maxtempF}°` : `${d.mintempC}° / ${d.maxtempC}°`;
                cell.add_child(new St.Label({text: range, style_class: 'mertnotch-weather-day-temp'}));
                const desc = d.hourly?.[4]?.weatherDesc?.[0]?.value ?? '';
                cell.add_child(new St.Label({text: desc, style_class: 'mertnotch-weather-day-desc'}));
                forecast.add_child(cell);
            }
            box.add_child(forecast);
        } catch (e) {
            logError(e, 'mertnotch:weather:render');
            box.add_child(new St.Label({text: 'Weather data malformed', style_class: 'mertnotch-empty'}));
        }

        return box;
    }

    _metaCell(label, value) {
        const c = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'mertnotch-weather-meta-cell'});
        c.add_child(new St.Label({text: label, style_class: 'mertnotch-weather-meta-label'}));
        c.add_child(new St.Label({text: `${value}`, style_class: 'mertnotch-weather-meta-value'}));
        return c;
    }
});
