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
        this._timer = 0;
        this._lastFetch = 0;
    }

    start() {
        this._fetch();
        const minutes = this._settings.get_int('weather-refresh');
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, minutes * 60, () => {
            this._fetch();
            return GLib.SOURCE_CONTINUE;
        });
        this._settingsSig = this._settings.connect('changed::weather-location', () => this._fetch());
        this._settingsSig2 = this._settings.connect('changed::weather-unit',     () => this._fetch());
    }

    stop() {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = 0; }
        if (this._settingsSig)  { this._settings.disconnect(this._settingsSig);  this._settingsSig = 0; }
        if (this._settingsSig2) { this._settings.disconnect(this._settingsSig2); this._settingsSig2 = 0; }
    }

    destroy() { this.stop(); }

    _fetch() {
        const loc = this._settings.get_string('weather-location') || '';
        const unit = this._settings.get_string('weather-unit') === 'imperial' ? 'u' : 'm';
        const url = `https://wttr.in/${encodeURIComponent(loc)}?format=j1`;
        const msg = Soup.Message.new('GET', url);
        msg.request_headers.append('User-Agent', 'mertnotch/0.1');
        this._soup.send_and_read_async(msg, GLib.PRIORITY_LOW, null, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                const text = new TextDecoder().decode(bytes.get_data());
                if (msg.status_code < 200 || msg.status_code >= 300) {
                    log(`mertnotch:weather: ${msg.status_code}`);
                    return;
                }
                this._data = JSON.parse(text);
                this._data._unit = unit;
                this._lastFetch = Date.now();
                this.emit('updated');
            } catch (e) { logError(e, 'mertnotch:weather'); }
        });
    }

    render() {
        const box = new St.BoxLayout({style_class: 'mertnotch-weather', vertical: true, x_expand: true, y_expand: true});
        if (!this._data) {
            box.add_child(new St.Label({
                text: 'Loading weather…',
                style_class: 'mertnotch-empty',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return box;
        }

        try {
            const cur   = this._data.current_condition?.[0];
            const area  = this._data.nearest_area?.[0]?.areaName?.[0]?.value ?? '—';
            const days  = this._data.weather ?? [];
            const unit  = this._data._unit ?? 'm';

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
