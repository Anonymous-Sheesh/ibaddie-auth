(function (root) {
    function dayNumber(value) {
        const d = new Date(value);
        return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;
    }
    function daysAgo(value, now = Date.now()) {
        const days = Math.max(0, dayNumber(now) - dayNumber(value));
        return days === 0 ? 'Today' : days === 1 ? '1 day ago' : `${days} days ago`;
    }
    function dateLabel(value) {
        return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    }
    root.AccountDates = { daysAgo, dateLabel };
})(typeof window === 'undefined' ? globalThis : window);
