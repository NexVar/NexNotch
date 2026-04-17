import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {readSessions} from './pomodoro.js';

export const Stats = GObject.registerClass(
class Stats extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
    }

    start() {}
    stop() {}
    destroy() {}

    _computeSummary(sessions) {
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const dayMs = 86400000;

        const works = sessions.filter(s => s.kind === 'work' && s.completed);

        const today = works.filter(s => new Date(s.started_at) >= startOfDay);
        const todayMin = today.reduce((a, s) => a + Math.round(s.duration_sec / 60), 0);

        const week = new Array(7).fill(0);
        for (let i = 0; i < 7; i++) {
            const dayStart = new Date(startOfDay.getTime() - i * dayMs);
            const dayEnd   = new Date(dayStart.getTime() + dayMs);
            const count = works.filter(s => {
                const t = new Date(s.started_at);
                return t >= dayStart && t < dayEnd;
            }).reduce((a, s) => a + Math.round(s.duration_sec / 60), 0);
            week[6 - i] = count;
        }

        let streak = 0;
        for (let i = 0; i < 365; i++) {
            const dayStart = new Date(startOfDay.getTime() - i * dayMs);
            const dayEnd   = new Date(dayStart.getTime() + dayMs);
            const hasAny = works.some(s => {
                const t = new Date(s.started_at);
                return t >= dayStart && t < dayEnd;
            });
            if (hasAny) streak++;
            else if (i === 0) continue;   /* today without a session yet — don't break streak */
            else break;
        }

        const hourBuckets = new Array(24).fill(0);
        for (const s of works) {
            const h = new Date(s.started_at).getHours();
            hourBuckets[h]++;
        }
        const peakHour = hourBuckets.indexOf(Math.max(...hourBuckets));

        const totalMin = works.reduce((a, s) => a + Math.round(s.duration_sec / 60), 0);

        return {todayCount: today.length, todayMin, week, streak, peakHour, totalCount: works.length, totalMin};
    }

    render() {
        const sessions = readSessions();
        const s = this._computeSummary(sessions);

        const box = new St.BoxLayout({style_class: 'mertnotch-stats', vertical: true, x_expand: true, y_expand: true});

        /* headline row */
        const head = new St.BoxLayout({style_class: 'mertnotch-stats-head'});
        const cell = (label, value) => {
            const c = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'mertnotch-stats-cell'});
            c.add_child(new St.Label({text: value, style_class: 'mertnotch-stats-value'}));
            c.add_child(new St.Label({text: label, style_class: 'mertnotch-stats-label'}));
            return c;
        };
        head.add_child(cell('Today',   `${s.todayCount}`));
        head.add_child(cell('Minutes', `${s.todayMin}`));
        head.add_child(cell('Streak',  `${s.streak}d`));
        head.add_child(cell('Peak',    s.peakHour >= 0 ? `${s.peakHour}:00` : '—'));
        box.add_child(head);

        /* weekly bar chart */
        const chartTitle = new St.Label({text: 'Last 7 days (minutes focused)', style_class: 'mertnotch-stats-chart-title'});
        box.add_child(chartTitle);
        const chart = new St.BoxLayout({style_class: 'mertnotch-stats-chart', vertical: false});
        const max = Math.max(1, ...s.week);
        const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        const now = new Date();
        const todayIdx = (now.getDay() + 6) % 7;
        for (let i = 0; i < 7; i++) {
            const col = new St.BoxLayout({style_class: 'mertnotch-stats-col', vertical: true, x_expand: true});
            const spacer = new St.Widget({style_class: 'mertnotch-stats-spacer', y_expand: true});
            const barHeight = Math.max(2, Math.round((s.week[i] / max) * 80));
            const bar = new St.Widget({
                style_class: 'mertnotch-stats-bar' + (i === 6 ? ' today' : ''),
                height: barHeight,
            });
            const valueLabel = new St.Label({
                text: s.week[i] > 0 ? `${s.week[i]}` : '',
                style_class: 'mertnotch-stats-bar-value',
            });
            const dayIdx = (todayIdx - (6 - i) + 7) % 7;
            const dayLabel = new St.Label({text: days[dayIdx], style_class: 'mertnotch-stats-bar-label'});
            col.add_child(spacer);
            col.add_child(valueLabel);
            col.add_child(bar);
            col.add_child(dayLabel);
            chart.add_child(col);
        }
        box.add_child(chart);

        const totals = new St.Label({
            text: `All time: ${s.totalCount} sessions · ${Math.round(s.totalMin / 60)}h ${s.totalMin % 60}m`,
            style_class: 'mertnotch-stats-totals',
        });
        box.add_child(totals);

        return box;
    }
});
