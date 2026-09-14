// ══════════════════════════════════════════════════════════════════════════════
// IBADDIE — ADMIN PANEL (admin.js v5.0)
// ══════════════════════════════════════════════════════════════════════════════
// NOTIFICATION SOUND — THE FIX:
// Browsers block audio until the user has interacted with the page. The old
// version could never play because its audio context was created/suspended
// before any click (and/or depended on an audio file that failed to load).
// This version:
//   1. unlocks a Web Audio context inside REAL user gestures (sign-in click,
//      "Enable / test sound" click),
//   2. synthesizes the chime with oscillators — no audio file to 404,
//   3. falls back to flashing the tab title if audio is still unavailable.
(() => {
    'use strict';

    const $ = id => document.getElementById(id);
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const IMG_RE = /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i;

    let pw = '';
    let rows = [];
    let lastRenderedList = [];
    let selected = new Set();
    let selectionMode = false;
    let knownPending = new Set();
    let firstPendingPoll = true;
    let soundOn = false;
    let pollTimer = null, hbTimer = null, titleTimer = null, msgTimer = null;
    const baseTitle = document.title;

    try { pw = sessionStorage.getItem('ib_pw') || ''; } catch (e) {}
    try { soundOn = localStorage.getItem('ib_admin_sound') === '1'; } catch (e) {}

    // ─── SOUND ENGINE (Web Audio, no files) ─────────────────────────────────────
    const Sound = (() => {
        let ctx = null;
        function ensure() {
            try {
                if (!ctx) {
                    const AC = window.AudioContext || window.webkitAudioContext;
                    if (!AC) return null;
                    ctx = new AC();
                }
                if (ctx.state === 'suspended') ctx.resume().catch(() => {});
                return ctx;
            } catch (e) { return null; }
        }
        function tone(freq, at, dur, type, vol) {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.type = type || 'sine';
            o.frequency.value = freq;
            g.gain.setValueAtTime(0.0001, at);
            g.gain.exponentialRampToValueAtTime(vol || 0.2, at + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
            o.connect(g); g.connect(ctx.destination);
            o.start(at); o.stop(at + dur + 0.05);
        }
        function chime() {
            const c = ensure(); if (!c || c.state !== 'running') return false;
            const t = c.currentTime + 0.02;
            tone(880, t, 0.18); tone(1174.66, t + 0.13, 0.20); tone(1567.98, t + 0.27, 0.38);
            return true;
        }
        function unlock() {
            const c = ensure(); if (!c) return false;
            try {
                const b = c.createBuffer(1, 1, 22050);
                const s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0);
            } catch (e) {}
            if (c.state === 'suspended') c.resume().catch(() => {});
            return true;
        }
        return { chime, unlock };
    })();

    // ─── HELPERS ─────────────────────────────────────────────────────────────────
    function msg(text, sticky) {
        const el = $('msg'); if (!el) return;
        el.textContent = text || '';
        if (msgTimer) { clearTimeout(msgTimer); msgTimer = null; }
        if (!sticky && text) msgTimer = setTimeout(() => { el.textContent = ''; }, 8000);
    }

    const genFallback = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });

    async function api(path, opts = {}) {
        const o = Object.assign({}, opts);
        o.headers = Object.assign({ Authorization: pw, 'Content-Type': 'application/json' }, opts.headers || {});
        if (o.body && typeof o.body !== 'string') o.body = JSON.stringify(o.body);
        o.cache = 'no-store';
        const r = await fetch(path, o);
        if (r.status === 401) { forceLogout('Session ended — please sign in again.'); throw new Error('unauthorized'); }
        let d = null;
        try { d = await r.json(); } catch (e) {}
        if (!r.ok) throw new Error((d && d.error) || ('Request failed (' + r.status + ')'));
        return d;
    }

    // ─── TAB TITLE FLASH (visual fallback when audio is blocked) ────────────────
    function startTitleFlash() {
        if (titleTimer) return;
        let on = false;
        titleTimer = setInterval(() => {
            on = !on;
            document.title = on ? '🔔 NEW CODE REQUEST!' : baseTitle;
        }, 1100);
    }
    function stopTitleFlash() {
        if (titleTimer) { clearInterval(titleTimer); titleTimer = null; document.title = baseTitle; }
    }

    // ─── SOUND CONTROLS ──────────────────────────────────────────────────────────
    function setSoundStatus(ok) {
        const el = $('soundStatus'); if (!el) return;
        el.textContent = ok
            ? 'Sound is ON — you will hear this chime when a new request arrives.'
            : 'Audio was blocked by the browser. Click "Enable / test sound" once more — browsers need one click before any sound can play.';
    }
    function setInitialSoundStatus() {
        const el = $('soundStatus'); if (!el) return;
        el.textContent = soundOn
            ? 'Sound was left ON — press "Enable / test sound" to hear the chime again.'
            : 'Sound enables when you press "Enable / test sound" (one click is required by browsers).';
    }
    // Exposed globally — admin.html onclick="testNotificationSound()"
    window.testNotificationSound = () => {
        soundOn = true;
        try { localStorage.setItem('ib_admin_sound', '1'); } catch (e) {}
        const unlocked = Sound.unlock();
        setTimeout(() => {
            const ok = unlocked && Sound.chime();
            setSoundStatus(ok);
            if (ok) { const b = $('presenceBadge'); if (b && b.textContent.indexOf('Online') !== -1) b.textContent = '🟢 Online — sound on'; }
        }, 120);
    };

    // ─── AUTH ────────────────────────────────────────────────────────────────────
    window.togglePw = () => {
        const el = $('pw');
        if (el) el.type = el.type === 'password' ? 'text' : 'password';
    };

    window.login = async () => {
        const val = ($('pw') && $('pw').value) || '';
        $('err').textContent = '';
        if (!val) { $('err').textContent = 'Enter the admin password.'; return; }
        try {
            const r = await fetch('/api/admin/pending', { headers: { Authorization: val }, cache: 'no-store' });
            if (r.status === 401) { $('err').textContent = 'Wrong password.'; return; }
            if (!r.ok) { $('err').textContent = 'Could not reach the server. Try again.'; return; }
            pw = val;
            try { sessionStorage.setItem('ib_pw', pw); } catch (e) {}
            enterDash();
        } catch (e) {
            $('err').textContent = 'Could not reach the server. Try again.';
        }
    };

    function forceLogout(text) {
        const cached = pw;
        try {
            if (cached) fetch('/api/admin/go-offline', {
                method: 'POST',
                headers: { Authorization: cached, 'Content-Type': 'application/json' },
                body: '{}', keepalive: true
            }).catch(() => {});
        } catch (e) {}
        try { sessionStorage.removeItem('ib_pw'); } catch (e) {}
        pw = '';
        stopLoops();
        const dash = $('dashSec'), login = $('loginSec');
        if (dash) dash.classList.remove('active');
        if (login) login.classList.add('active');
        if (text) msg(text);
    }
    window.logout = () => forceLogout('Signed out.');

    function enterDash() {
        $('loginSec').classList.remove('active');
        $('dashSec').classList.add('active');
        Sound.unlock(); // sign-in click = real user gesture → audio unlocked here
        firstPendingPoll = true;
        knownPending = new Set();
        fetchList();
        stopLoops();
        pollPending();
        pollTimer = setInterval(pollPending, 5000);
        hbTimer = setInterval(heartbeat, 15000);
        heartbeat();
    }
    function stopLoops() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
        stopTitleFlash();
    }

    async function heartbeat() {
        try {
            await api('/api/admin/heartbeat', { method: 'POST', body: {} });
            const b = $('presenceBadge');
            if (b) b.textContent = soundOn ? '🟢 Online — sound on' : '🟢 Online — sound off';
        } catch (e) {
            const b = $('presenceBadge');
            if (b) b.textContent = '🔴 Offline';
        }
    }

    // ─── PENDING REQUESTS (poll every 5s + chime on new arrivals) ───────────────
    async function pollPending() {
        let d;
        try { d = await api('/api/admin/pending'); } catch (e) { return; }
        const pending = (d && d.pending) || [];
        renderPending(pending);

        const ids = new Set(pending.map(p => p.requestId));
        const fresh = pending.filter(p => !knownPending.has(p.requestId));
        if (firstPendingPoll) {
            if (pending.length) {
                msg('You have ' + pending.length + ' code request' + (pending.length > 1 ? 's' : '') + ' waiting.');
                Sound.chime();
            }
        } else if (fresh.length) {
            const ok = Sound.chime();
            if (!ok) startTitleFlash(); // audio blocked → flash the tab title instead
            msg('🔔 New code request from ' + fresh.map(f => f.buyerUser || 'a buyer').join(', ') + '!');
        }
        if (!pending.length) stopTitleFlash();
        knownPending = ids;
        firstPendingPoll = false;

        const ps = $('pendingStatus');
        if (ps) ps.textContent = 'Auto-refreshes every 5s · sound is ' + (soundOn ? 'ON' : 'OFF') + ' — click "Enable / test sound" above.';
    }

    function renderPending(pending) {
        const count = $('pCount'); if (count) count.textContent = pending.length;
        const list = $('pList'); if (!list) return;
        if (!pending.length) { list.innerHTML = '<p class="empty">No pending requests</p>'; return; }
        list.innerHTML = pending.map(p => {
            const t = p.submittedAt ? new Date(p.submittedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
            const ago = Number.isFinite(p.timeAgo) ? p.timeAgo : Math.floor((Date.now() - (p.submittedAt || 0)) / 1000);
            const shot = p.screenshot && IMG_RE.test(p.screenshot)
                ? '<img src="' + p.screenshot + '" alt="Buyer screenshot" style="display:block;width:100%;max-height:460px;object-fit:contain;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:#000">'
                : '<p class="muted small">Screenshot unavailable.</p>';
            return '<div style="border:1px solid rgba(255,215,0,.28);border-radius:14px;padding:14px;margin:10px 0;background:rgba(255,215,0,.05)">' +
                '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">' +
                '<div><strong>' + esc(p.buyerUser || 'Buyer') + '</strong><span class="muted small"> · ' + esc(p.msEmail || 'no MS email') + ' · ' + t + ' · ' + ago + 's ago</span></div>' +
                '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
                '<button type="button" onclick="approveRequest(\'' + p.requestId + '\')">✅ Send code</button>' +
                '<button type="button" onclick="askFresh(\'' + p.requestId + '\')">🔄 Ask fresh</button>' +
                '<button type="button" class="danger" onclick="showRejectForm(\'' + p.requestId + '\')">✕ Reject</button>' +
                '</div></div>' +
                '<div style="margin-top:10px">' + shot + '</div>' +
                '<div id="rejrow-' + p.requestId + '" style="display:none;margin-top:10px">' +
                '<input id="rejreason-' + p.requestId + '" type="text" maxlength="300" placeholder="Reason to send the buyer (e.g. Blurry — show the whole screen)" style="width:100%;padding:9px 10px;border-radius:9px;border:1px solid rgba(255,255,255,.22);background:#12121c;color:#fff">' +
                '<div style="display:flex;gap:8px;margin-top:8px">' +
                '<button type="button" class="danger" onclick="confirmReject(\'' + p.requestId + '\')">Confirm reject</button>' +
                '<button type="button" onclick="hideRejectForm(\'' + p.requestId + '\')">Cancel</button>' +
                '</div></div></div>';
        }).join('');
    }

    window.approveRequest = async id => {
        try {
            const d = await api('/api/admin/approve', { method: 'POST', body: { requestId: id } });
            msg('✅ Code ' + d.code + ' sent to the buyer (expires in ' + d.expiresIn + 's).');
            pollPending();
        } catch (e) { if (e.message !== 'unauthorized') msg('Could not approve: ' + e.message); }
    };
    window.askFresh = async id => {
        try {
            await api('/api/admin/request-fresh', { method: 'POST', body: { requestId: id } });
            msg('🔄 Asked the buyer for a fresh screenshot.');
            pollPending();
        } catch (e) { if (e.message !== 'unauthorized') msg('Could not request a fresh screenshot: ' + e.message); }
    };
    window.showRejectForm = id => {
        const row = $('rejrow-' + id); if (row) row.style.display = 'block';
        const inp = $('rejreason-' + id); if (inp) inp.focus();
    };
    window.hideRejectForm = id => {
        const row = $('rejrow-' + id); if (row) row.style.display = 'none';
    };
    window.confirmReject = async id => {
        const inp = $('rejreason-' + id);
        const reason = (inp && inp.value.trim()) || 'Screenshot rejected.';
        try {
            await api('/api/admin/reject', { method: 'POST', body: { requestId: id, reason: reason } });
            msg('Reject reason sent to the buyer.');
            pollPending();
        } catch (e) { if (e.message !== 'unauthorized') msg('Could not reject: ' + e.message); }
    };

    // ─── ACCOUNTS TABLE ──────────────────────────────────────────────────────────
    async function fetchList() {
        const st = $('listStatus'); if (st) st.textContent = 'Loading accounts…';
        let d;
        try { d = await api('/api/admin/list'); } catch (e) { if (st && e.message !== 'unauthorized') st.textContent = 'Could not load accounts.'; return; }
        rows = (d && d.keys) || [];
        renderTable();
    }
    window.fetchList = fetchList;

    function buyerLink(name) {
        return location.origin + '/request.html?t=' + encodeURIComponent(name);
    }

    function filteredRows() {
        const q = (($('accountSearch') || {}).value || '').trim().toLowerCase();
        let out = rows;
        if (q) out = rows.filter(r => {
            const m = r.metadata || {};
            return ((m.user || '') + ' ' + (m.msEmail || '')).toLowerCase().includes(q);
        });
        const sort = (($('accountSort') || {}).value) || 'newest';
        const md = r => r.metadata || {};
        const arr = out.slice();
        if (sort === 'newest') arr.sort((a, b) => (md(b).createdAt || 0) - (md(a).createdAt || 0));
        else if (sort === 'oldest') arr.sort((a, b) => (md(a).createdAt || 0) - (md(b).createdAt || 0));
        else if (sort === 'reused') arr.sort((a, b) => (md(b).lastReusedAt || 0) - (md(a).lastReusedAt || 0));
        else if (sort === 'count') arr.sort((a, b) => (md(b).reuseCount || 0) - (md(a).reuseCount || 0));
        return arr;
    }

    function renderTable() {
        const tbody = $('tbl'); if (!tbody) return;
        const list = filteredRows();
        lastRenderedList = list;
        if ($('accountCount')) $('accountCount').textContent = rows.length;

        const totalReuses = rows.reduce((s, r) => s + (((r.metadata || {}).reuseCount) || 0), 0);
        const reusedAccounts = rows.filter(r => ((r.metadata || {}).reuseCount || 0) > 0).length;
        if ($('totalAccounts')) $('totalAccounts').textContent = rows.length;
        if ($('reusedAccounts')) $('reusedAccounts').textContent = reusedAccounts;
        if ($('totalReuses')) $('totalReuses').textContent = totalReuses;

        if (!list.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty">' + (rows.length ? 'No accounts match your search.' : 'No accounts yet — add one above.') + '</td></tr>';
            updateSelectionUI();
            const st = $('listStatus');
            if (st) st.textContent = rows.length + ' account' + (rows.length === 1 ? '' : 's') + ' · updated ' + new Date().toLocaleTimeString();
            return;
        }

        tbody.innerHTML = list.map((r, i) => {
            const m = r.metadata || {};
            const reuse = m.reuseCount > 0
                ? '↻ ' + m.reuseCount + ' · last ' + AD.rel(m.lastReusedAt)
                : 'No reuses yet';
            const added = (m.addedDateEstimated ? '≈ ' : '') + AD.fmtDate(m.createdAt);
            const link = buyerLink(r.name);
            return '<tr>' +
                '<td class="selection-cell"' + (selectionMode ? '' : ' hidden') + '>' +
                    (selectionMode ? '<input type="checkbox" value="' + esc(r.name) + '" ' + (selected.has(r.name) ? 'checked' : '') + ' onchange="onRowSelect(this)" aria-label="Select ' + esc(m.user || 'account') + '">' : '') +
                '</td>' +
                '<td><strong>' + esc(m.user || '?') + '</strong>' + (m.hasPending ? ' <span title="Has a pending request">⏳</span>' : '') + '</td>' +
                '<td>' + esc(m.msEmail || '—') + '</td>' +
                '<td>' + esc(added) + '</td>' +
                '<td>' + esc(reuse) + '</td>' +
                '<td><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
                    '<input readonly value="' + esc(link) + '" onclick="this.select()" style="max-width:210px;padding:4px 6px;border-radius:6px;border:1px solid rgba(255,255,255,.18);background:#101018;color:#cfd3ff;font-size:.72rem">' +
                    '<button type="button" title="Copy buyer link" onclick="copyBuyerLink(' + i + ')">📋</button>' +
                    '<button type="button" title="Open buyer page" onclick="openBuyerLink(' + i + ')">↗</button>' +
                '</div></td>' +
                '<td><div style="display:flex;gap:6px;flex-wrap:wrap">' +
                    '<button type="button" title="Show current TOTP code" onclick="viewCode(' + i + ')">👁 Code</button>' +
                    '<button type="button" title="Mark reused today" onclick="markReused(' + i + ')">♻ Reused</button>' +
                    '<button type="button" title="Reuse history" onclick="showHistory(' + i + ')">🕓</button>' +
                    '<button type="button" class="danger" title="Delete" onclick="openDeleteRow(' + i + ')">🗑</button>' +
                '</div></td>' +
            '</tr>';
        }).join('');

        const st = $('listStatus');
        if (st) st.textContent = rows.length + ' account' + (rows.length === 1 ? '' : 's') + ' · updated ' + new Date().toLocaleTimeString();
        updateSelectionUI();
    }

    // ─── SELECTION / BULK DELETE ─────────────────────────────────────────────────
    window.onRowSelect = el => {
        if (el.checked) selected.add(el.value); else selected.delete(el.value);
        updateSelectionUI();
    };
    window.toggleSelection = () => {
        selectionMode = !selectionMode;
        if (!selectionMode) selected.clear();
        const btn = $('selectBtn');
        if (btn) { btn.setAttribute('aria-pressed', String(selectionMode)); btn.textContent = selectionMode ? 'Done selecting' : 'Select accounts'; }
        renderTable();
    };
    window.clearSelection = () => { selected.clear(); updateSelectionUI(); renderTable(); };
    function updateSelectionUI() {
        const bar = $('selectionBar'), cnt = $('selectionCount'), del = $('bulkDeleteBtn'), all = $('selectAll');
        if (bar) bar.hidden = !selectionMode;
        if (cnt) cnt.textContent = selected.size + ' selected';
        if (del) del.disabled = selected.size === 0;
        if (all) all.checked = selectionMode && lastRenderedList.length > 0 && lastRenderedList.every(r => selected.has(r.name));
        const th = document.querySelector('thead .selection-cell');
        if (th) th.hidden = !selectionMode;
    }
    window.openDeleteRow = i => {
        const r = lastRenderedList[i];
        if (r) openDelete([r.name]);
    };
    window.openDelete = ids => {
        const list = Array.isArray(ids) ? ids : Array.from(selected);
        if (!list.length) return;
        const names = list.map(id => {
            const row = rows.find(x => x.name === id);
            return row ? (row.metadata.user || id) : id;
        });
        $('deleteSummary').textContent = 'You are about to delete ' + list.length + ' account' + (list.length > 1 ? 's' : '') + ':';
        $('deleteList').innerHTML = names.map(n => '<li>' + esc(n) + '</li>').join('');
        $('deleteDialog').dataset.ids = JSON.stringify(list);
        $('deleteDialog').showModal();
    };
    window.confirmDelete = async () => {
        const dlg = $('deleteDialog');
        let ids = [];
        try { ids = JSON.parse(dlg.dataset.ids || '[]'); } catch (e) {}
        if (!ids.length) { dlg.close(); return; }
        try {
            const d = await api('/api/admin/delete-tokens', { method: 'POST', body: { tokens: ids } });
            msg('Deleted ' + d.deleted.length + ' account' + (d.deleted.length > 1 ? 's' : '') + ((d.failed && d.failed.length) ? (' · ' + d.failed.length + ' failed') : '') + '.');
        } catch (e) { if (e.message !== 'unauthorized') msg('Delete failed: ' + e.message); }
        selected.clear();
        dlg.close();
        fetchList();
    };

    // ─── ROW ACTIONS ─────────────────────────────────────────────────────────────
    window.viewCode = async i => {
        const r = lastRenderedList[i]; if (!r) return;
        try {
            const d = await api('/api/admin/view-code?token=' + encodeURIComponent(r.name));
            msg('🔐 Current code for ' + (d.user || 'buyer') + ': ' + d.code + ' (expires in ' + d.expiresIn + 's)');
        } catch (e) { if (e.message !== 'unauthorized') msg('Could not generate code: ' + e.message); }
    };
    window.markReused = async i => {
        const r = lastRenderedList[i]; if (!r) return;
        try {
            await api('/api/admin/mark-reused', { method: 'POST', body: { token: r.name, eventId: (crypto.randomUUID ? crypto.randomUUID() : genFallback()) } });
            msg('♻ Marked ' + (r.metadata.user || 'account') + ' as reused today.');
            fetchList();
        } catch (e) { if (e.message !== 'unauthorized') msg('Could not mark reused: ' + e.message); }
    };
    window.showHistory = i => {
        const r = lastRenderedList[i]; if (!r) return;
        const m = r.metadata || {};
        $('historyAccount').textContent = (m.user || 'Account') + ' — ' + (m.reuseCount || 0) + ' reuse' + (m.reuseCount === 1 ? '' : 's') + ' recorded.';
        const hist = m.reuseHistory || [];
        $('historyList').innerHTML = hist.length
            ? hist.map(ev => '<li>' + AD.fmtDate(ev.at) + ' · ' + AD.rel(ev.at) + '</li>').join('')
            : '<li class="muted">No reuses recorded yet.</li>';
        $('historyDialog').showModal();
    };
    window.copyBuyerLink = async i => {
        const r = lastRenderedList[i]; if (!r) return;
        const link = buyerLink(r.name);
        try {
            await navigator.clipboard.writeText(link);
            msg('📋 Buyer link copied — send it to ' + (r.metadata.user || 'the buyer'));
        } catch (e) { window.prompt('Copy this link:', link); }
    };
    window.openBuyerLink = i => {
        const r = lastRenderedList[i];
        if (r) window.open(buyerLink(r.name), '_blank');
    };

    // ─── ADD ACCOUNT ─────────────────────────────────────────────────────────────
    window.addToken = async () => {
        const user = ($('nUser').value || '').trim();
        const ms = ($('nMs').value || '').trim();
        const secret = ($('nSecret').value || '').trim();
        if (!user || !secret) { msg('Buyer email/label and TOTP secret are required.'); return; }
        const btn = $('addBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
        try {
            const d = await api('/api/admin/create-token', { method: 'POST', body: { user: user, secret: secret, msEmail: ms || null } });
            const link = buyerLink(d.token);
            let copied = false;
            try { await navigator.clipboard.writeText(link); copied = true; } catch (e) {}
            msg(copied
                ? '✅ Account added — buyer link COPIED to clipboard. Send it to ' + user + '.'
                : '✅ Account added. Buyer link: ' + link);
            $('nUser').value = ''; $('nMs').value = ''; $('nSecret').value = '';
            fetchList();
        } catch (e) { if (e.message !== 'unauthorized') msg('Could not add account: ' + e.message); }
        finally { if (btn) { btn.disabled = false; btn.textContent = 'Generate link'; } }
    };

    // ─── INIT ────────────────────────────────────────────────────────────────────
    function init() {
        const all = $('selectAll');
        if (all) all.addEventListener('change', e => {
            if (e.target.checked) lastRenderedList.forEach(r => selected.add(r.name));
            else lastRenderedList.forEach(r => selected.delete(r.name));
            renderTable();
        });
        const search = $('accountSearch');
        if (search) search.addEventListener('input', renderTable);
        const sort = $('accountSort');
        if (sort) sort.addEventListener('change', renderTable);
        setInitialSoundStatus();

        if (pw) {
            // Silent re-validation of the stored password after a page reload
            fetch('/api/admin/pending', { headers: { Authorization: pw }, cache: 'no-store' })
                .then(r => {
                    if (r.ok) enterDash();
                    else { try { sessionStorage.removeItem('ib_pw'); } catch (e) {} pw = ''; }
                })
                .catch(() => {});
        }
    }
    init();
})();

