// ══════════════════════════════════════════════════════════════════════════════
// IBADDIE — ACCOUNT DATE HELPERS (account-dates.js v4.1)
// ══════════════════════════════════════════════════════════════════════════════
// Shared by admin.js for "Added" and "Reuse activity" columns.
// All formatting uses the viewer's local timezone (as noted in the admin footer).
(() => {
    'use strict';

    const startOfDay = d => {
        const x = new Date(d);
        x.setHours(0, 0, 0, 0);
        return x;
    };

    window.AD = {
        // "7 Sep 2026"
        fmtDate(ts) {
            if (!ts) return '—';
            const d = new Date(ts);
            if (isNaN(d)) return '—';
            return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
        },
        // "7 Sep, 14:05"
        fmtDateTime(ts) {
            if (!ts) return '—';
            const d = new Date(ts);
            if (isNaN(d)) return '—';
            return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', ' +
                d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        },
        // Whole calendar days between the timestamp and today
        daysAgo(ts) {
            if (!ts) return null;
            const d = new Date(ts);
            if (isNaN(d)) return null;
            return Math.round((startOfDay(Date.now()) - startOfDay(d)) / 86400000);
        },
        // "today" / "yesterday" / "5 days ago" / "7 Sep 2026"
        rel(ts) {
            if (!ts) return 'never';
            const d = window.AD.daysAgo(ts);
            if (d == null) return 'never';
            if (d <= 0) return 'today';
            if (d === 1) return 'yesterday';
            if (d < 30) return d + ' days ago';
            return window.AD.fmtDate(ts);
        }
    };
})();
