// ══════════════════════════════════════════════════════════════════════════════
// admin.js — V4 (account dates, reuse history and bulk selection)
// ══════════════════════════════════════════════════════════════════════════════

const API = "https://totp-backend.ibaddie.workers.dev";
const SITE = window.location.origin + window.location.pathname.replace('/admin.html', '');
let auth = "";
const $ = id => document.getElementById(id);


// ─── NOTIFICATION SOUND ────────────────────────────────────────────────────────
let audioCtx = null;
function playNotificationSound() {
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        [880, 1320].forEach((freq, i) => {
            setTimeout(() => {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.connect(gain); gain.connect(audioCtx.destination);
                osc.frequency.value = freq; osc.type = 'sine';
                gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
                osc.start(audioCtx.currentTime); osc.stop(audioCtx.currentTime + 0.5);
            }, i * 200);
        });
    } catch {}
}

// ─── LOGIN ─────────────────────────────────────────────────────────────────────
function login() {
    const p = $('pw').value.trim();
    if (!p) return showErr("Password required");
    auth = p;
    fetch(`${API}/api/admin/list`, { headers: { Authorization: auth } })
        .then(r => {
            if (r.ok) {
                $('loginSec').classList.remove('active');
                $('dashSec').classList.add('active');
                startHeartbeat();
                startPending();
                fetchList();
            } else if (r.status === 401) {
                showErr("Wrong password");
            } else {
                // Show the actual server error message
                r.json().then(d => {
                    showErr("Server error: " + (d.error || "status " + r.status));
                }).catch(() => {
                    showErr("Server error (status " + r.status + ")");
                });
            }
        })
        .catch(() => showErr("Network error — is the worker online?"));
}
window.login = login;
function togglePw() { const i = $('pw'); i.type = i.type === 'password' ? 'text' : 'password'; }
window.togglePw = togglePw;

function logout() {
    fetch(`${API}/api/admin/go-offline`, { method: 'POST', headers: { Authorization: auth } }).catch(() => {});
    stopHeartbeat(); stopPending(); auth = ""; location.reload();
}
window.logout = logout;

window.addEventListener('beforeunload', () => {
    if (auth) fetch(`${API}/api/admin/go-offline`, { method: 'POST', headers: { Authorization: auth }, keepalive: true }).catch(() => {});
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && auth) { beat(); pollPending(); if (!deleting) renderAccounts(); }
});

// ─── HEARTBEAT ─────────────────────────────────────────────────────────────────
let hbTimer = null;
function startHeartbeat() { stopHeartbeat(); beat(); hbTimer = setInterval(beat, 3000); }
function stopHeartbeat() { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } }
async function beat() {
    try {
        const response = await fetch(`${API}/api/admin/heartbeat`, { method: 'POST', headers: { Authorization: auth } });
        $('presenceBadge').textContent = response.ok ? '● Online to buyers' : 'Connection interrupted';
    } catch { $('presenceBadge').textContent = 'Connection interrupted'; }
}

// ─── PENDING REQUESTS ──────────────────────────────────────────────────────────
let pTimer = null;
function startPending() { stopPending(); pollPending(); pTimer = setInterval(pollPending, 8000); }
function stopPending() { if (pTimer) { clearInterval(pTimer); pTimer = null; } }

// Track which request IDs we've already shown (to detect NEW ones for sound)
const shownRequestIds = new Set();

async function pollPending() {
    try {
        const r = await fetch(`${API}/api/admin/pending`, { headers: { Authorization: auth } });
        if (!r.ok) return;
        const d = await r.json();
        const pending = d.pending || [];

        // Sound: new request arrived that we haven't seen before
        let hasNew = false;
        pending.forEach(p => { if (!shownRequestIds.has(p.requestId)) hasNew = true; });
        if (hasNew && document.visibilityState !== 'visible') playNotificationSound();
        pending.forEach(p => shownRequestIds.add(p.requestId));

        renderPending(pending);
    } catch {}
}

function renderPending(pending) {
    $('pCount').textContent = pending.length;
    const container = $('pList');
    container.replaceChildren();
    if (!pending.length) { container.innerHTML = '<p class="empty">All caught up. No pending requests.</p>'; return; }
    for (const r of pending) {
        const card = document.createElement('div'); card.className = 'req-card'; card.id = 'card-' + r.requestId;
        const info = document.createElement('div'); info.className = 'req-info';
        const label = document.createElement('strong'); label.textContent = r.buyerUser;
        const status = document.createElement('span');
        status.textContent = (r.status === 'request_fresh' ? 'Fresh requested' : 'Pending') + ' · ' + (r.timeAgo < 60 ? r.timeAgo + 's ago' : Math.floor(r.timeAgo / 60) + 'm ago');
        info.append(label, status); card.appendChild(info);
        const email = document.createElement('p'); email.className = 'muted small'; email.textContent = 'MS: ' + (r.msEmail || '?'); card.appendChild(email);
        if (typeof r.screenshot === 'string' && /^(https?:\/\/|data:image\/(png|jpeg|jpg|webp);base64,)/i.test(r.screenshot)) {
            const image = document.createElement('img'); image.className = 'req-img'; image.src = r.screenshot; image.alt = 'Launcher screenshot from ' + r.buyerUser;
            image.addEventListener('click', () => window.open(r.screenshot, '_blank', 'noopener,noreferrer')); card.appendChild(image);
        }
        const buttons = document.createElement('div'); buttons.className = 'req-btns';
        for (const [text, css, action] of [['Approve', 'approve', approve], ['Reject', 'reject', reject], ['Ask fresh', 'fresh', fresh]]) {
            const button = document.createElement('button'); button.className = 'req-btn ' + css; button.textContent = text;
            button.addEventListener('click', () => action(r.requestId)); buttons.appendChild(button);
        }
        card.appendChild(buttons); container.appendChild(card);
    }
}

// Remove a card from the DOM immediately after action
function removeCard(requestId) {
    const card = $('card-' + requestId);
    if (card) {
        card.style.transition = 'opacity 0.3s, transform 0.3s';
        card.style.opacity = '0';
        card.style.transform = 'translateX(20px)';
        setTimeout(() => card.remove(), 300);
    }
}

async function approve(id) {
    try {
        const r = await fetch(`${API}/api/admin/approve`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: id }) });
        if (!r.ok) throw new Error('Failed');
        const d = await r.json();
        // Only show the code if it's not null (not in needsFreshWindow mode)
        if (d.code) {
            showMsg(`✅ Code ${d.code} sent to buyer (${d.expiresIn}s)`);
        } else {
            showMsg(`✅ Approved — buyer will see fresh code shortly`);
        }
        removeCard(id); // remove immediately
        pollPending(); // refresh
    } catch (e) { alert('Error: ' + e.message); }
}
window.approve = approve;

async function reject(id) {
    const reason = prompt('Rejection reason:', 'This doesn\'t show a Minecraft launcher. Please follow the guide.');
    if (reason === null) return;
    try {
        const r = await fetch(`${API}/api/admin/reject`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: id, reason }) });
        if (!r.ok) throw new Error('Failed');
        showMsg('✗ Rejected — buyer notified');
        removeCard(id);
        pollPending();
    } catch (e) { alert('Error: ' + e.message); }
}
window.reject = reject;

async function fresh(id) {
    try {
        const r = await fetch(`${API}/api/admin/request-fresh`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: id }) });
        if (!r.ok) throw new Error('Failed');
        showMsg('🔄 Buyer asked for fresh screenshot');
        removeCard(id);
        pollPending();
    } catch (e) { alert('Error: ' + e.message); }
}
window.fresh = fresh;

// Account directory: selections refer to stable token IDs, never row positions.
let accounts = [], visibleAccounts = [], selecting = false, listLoading = false, deleting = false;
let trackingReady = false, deleteTargets = [], messageTimer;
const selected = new Set(), deletedThisSession = new Set(), reuseBusy = new Set();
const recentReuseEvents = new Map(), retryReuseIds = new Map();
const { dateLabel, daysAgo } = AccountDates;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

async function adminRequest(path, body) {
    const response = await fetch(`${API}/api/admin/${path}`, {
        method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
        headers: { Authorization: auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) { logout(); throw new Error('Session expired. Please sign in again.'); }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}). Please retry.`);
    return data;
}

async function fetchList() {
    if (listLoading || deleting) return;
    listLoading = true; $('refreshBtn').disabled = true;
    $('listStatus').textContent = 'Refreshing accounts…';
    try {
        const data = await adminRequest('list');
        if (!Array.isArray(data.keys)) throw new Error('The server returned an invalid account list.');
        trackingReady = data.trackingVersion === 1;
        accounts = data.keys.filter(k => !deletedThisSession.has(k.name));
        for (const account of accounts) mergeReuseHistory(account);
        const ids = new Set(accounts.map(k => k.name));
        for (const id of selected) if (!ids.has(id)) selected.delete(id);
        renderAccounts();
        if (!trackingReady) showErr('Deploy the updated Worker to enable saved dates, reuse tracking and bulk deletion.');
        if (data.note) showErr(data.note);
    } catch (e) {
        $('listStatus').textContent = 'Could not refresh. Any accounts below are from the last successful load.';
        showErr(e.message);
    } finally { listLoading = false; $('refreshBtn').disabled = false; }
}
window.fetchList = fetchList;

function mergeReuseHistory(account) {
    const m = account.metadata ||= {};
    const events = new Map((m.reuseHistory || []).map(e => [e.id, e]));
    for (const event of recentReuseEvents.get(account.name) || []) events.set(event.id, event);
    m.reuseHistory = [...events.values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
    m.reuseCount = m.reuseHistory.length;
    m.lastReusedAt = m.reuseHistory[0]?.at || null;
}

function renderAccounts() {
    const query = $('accountSearch').value.trim().toLowerCase();
    visibleAccounts = accounts.filter(k => `${k.metadata.user} ${k.metadata.msEmail || ''}`.toLowerCase().includes(query));
    const sort = $('accountSort').value;
    visibleAccounts.sort((a, b) => {
        const x = a.metadata, y = b.metadata;
        if (sort === 'oldest') return x.createdAt - y.createdAt;
        if (sort === 'reused') return (y.lastReusedAt || 0) - (x.lastReusedAt || 0);
        if (sort === 'count') return y.reuseCount - x.reuseCount;
        return y.createdAt - x.createdAt;
    });
    $('totalAccounts').textContent = accounts.length;
    $('accountCount').textContent = accounts.length;
    $('reusedAccounts').textContent = accounts.filter(k => k.metadata.reuseCount > 0).length;
    $('totalReuses').textContent = accounts.reduce((sum, k) => sum + k.metadata.reuseCount, 0);
    $('listStatus').textContent = `${visibleAccounts.length} of ${accounts.length} accounts`;
    $('tbl').innerHTML = visibleAccounts.map(k => {
        const m = k.metadata, id = escapeHtml(k.name);
        return `<tr data-token="${id}" class="${selected.has(k.name) ? 'selected' : ''}">
            <td class="selection-cell" ${selecting ? '' : 'hidden'}><input type="checkbox" data-select="${id}" aria-label="Select ${escapeHtml(m.user)}" ${selected.has(k.name) ? 'checked' : ''} ${deleting ? 'disabled' : ''}></td>
            <td class="account-cell" data-label="Buyer"><strong>${escapeHtml(m.user || '?')}</strong>${m.hasPending ? '<span class="sub pending-label">Pending request</span>' : ''}</td>
            <td class="account-cell" data-label="MS email">${escapeHtml(m.msEmail || '—')}</td>
            <td class="date-cell" data-label="Added">${trackingReady ? dateLabel(m.createdAt) : 'Update required'}<span class="sub">${trackingReady ? (m.addedDateEstimated ? 'Assigned to existing account' : daysAgo(m.createdAt)) : 'Deploy updated Worker'}</span></td>
            <td class="date-cell" data-label="Reuse activity"><span class="reuse-badge">${m.reuseCount ? `${m.reuseCount} ${m.reuseCount === 1 ? 'reuse' : 'reuses'}` : 'Not reused'}</span>${m.lastReusedAt ? `<span class="sub">${daysAgo(m.lastReusedAt)} · ${dateLabel(m.lastReusedAt)}</span><button class="link-btn" data-action="history" data-id="${id}">View history</button>` : '<span class="sub">No reuse recorded</span>'}</td>
            <td data-label="Delivery"><button class="link-btn" data-action="copy" data-id="${id}">Copy link</button></td>
            <td data-label="Actions"><div class="actions"><button data-action="reuse" data-id="${id}" ${!trackingReady || reuseBusy.has(k.name) || deleting ? 'disabled' : ''}>${reuseBusy.has(k.name) ? 'Saving…' : retryReuseIds.has(k.name) ? 'Retry save' : '↻ Mark reused'}</button><button data-action="view" data-id="${id}" ${deleting ? 'disabled' : ''}>View code</button><button class="danger" data-action="delete" data-id="${id}" ${deleting || !trackingReady ? 'disabled' : ''}>Delete</button></div></td>
        </tr>`;
    }).join('') || `<tr><td colspan="7" class="empty">${query ? 'No matching accounts. Try another email.' : 'No accounts yet. Add your first account above.'}</td></tr>`;
    updateSelection();
}

function updateSelection() {
    $('selectBtn').textContent = selecting ? 'Done selecting' : 'Select accounts';
    $('selectBtn').setAttribute('aria-pressed', String(selecting));
    document.querySelector('th.selection-cell').hidden = !selecting;
    $('selectionBar').hidden = !selecting;
    $('selectionCount').textContent = `${selected.size} selected`;
    $('bulkDeleteBtn').textContent = `Delete selected${selected.size ? ` (${selected.size})` : ''}`;
    $('bulkDeleteBtn').disabled = !selected.size || deleting || !trackingReady;
    const count = visibleAccounts.filter(k => selected.has(k.name)).length;
    $('selectAll').checked = !!visibleAccounts.length && count === visibleAccounts.length;
    $('selectAll').indeterminate = count > 0 && count < visibleAccounts.length;
    $('selectAll').disabled = !visibleAccounts.length || deleting;
}
function toggleSelection() { if (deleting) return; selecting = !selecting; selected.clear(); renderAccounts(); }
function clearSelection() { if (deleting) return; selected.clear(); renderAccounts(); }
$('selectAll').addEventListener('change', event => {
    for (const k of visibleAccounts) event.target.checked ? selected.add(k.name) : selected.delete(k.name);
    renderAccounts();
});
$('accountSearch').addEventListener('input', () => { selected.clear(); renderAccounts(); });
$('accountSort').addEventListener('change', renderAccounts);
$('tbl').addEventListener('change', event => {
    const id = event.target.dataset.select;
    if (!id || deleting) return;
    event.target.checked ? selected.add(id) : selected.delete(id);
    event.target.closest('tr').classList.toggle('selected', event.target.checked);
    updateSelection();
});
$('tbl').addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    const id = button.dataset.id;
    const actions = { reuse: markReused, history: showHistory, view: viewCode, delete: openDelete, copy: id => copy(`${SITE}/request.html?token=${encodeURIComponent(id)}`) };
    actions[button.dataset.action]?.(id);
});

async function markReused(id) {
    if (reuseBusy.has(id) || deleting || !trackingReady) return;
    reuseBusy.add(id);
    const eventId = retryReuseIds.get(id) || crypto.randomUUID();
    retryReuseIds.set(id, eventId); // Reuse this identity if the response is lost.
    renderAccounts();
    try {
        const data = await adminRequest('mark-reused', { token: id, eventId });
        if (!data.event?.id || !Number.isFinite(data.event.at)) throw new Error('Save was not confirmed. Retry save to check this reuse.');
        const events = recentReuseEvents.get(id) || [];
        if (!events.some(e => e.id === data.event.id)) events.push(data.event);
        recentReuseEvents.set(id, events);
        const account = accounts.find(k => k.name === id);
        if (account) {
            mergeReuseHistory(account);
            showMsg(`Reused ${account.metadata.msEmail || account.metadata.user} today. Total: ${account.metadata.reuseCount}.`);
        }
        retryReuseIds.delete(id);
    } catch (e) { showErr(`${e.message} Click Retry save to confirm this same reuse without adding another.`); }
    finally { reuseBusy.delete(id); renderAccounts(); }
}

function showHistory(id) {
    const account = accounts.find(k => k.name === id);
    if (!account) return;
    $('historyAccount').textContent = account.metadata.msEmail || account.metadata.user;
    $('historyList').replaceChildren();
    account.metadata.reuseHistory.forEach((event, i, events) => {
        const li = document.createElement('li');
        li.textContent = `Reuse #${events.length - i} · ${dateLabel(event.at)} · ${daysAgo(event.at)}`;
        const time = document.createElement('small');
        time.textContent = new Date(event.at).toLocaleTimeString();
        li.appendChild(time); $('historyList').appendChild(li);
    });
    $('historyDialog').showModal();
}

function openDelete(id) {
    if (deleting || !trackingReady) return;
    deleteTargets = id ? [id] : [...selected];
    if (!deleteTargets.length) return;
    $('deleteTitle').textContent = `Delete ${deleteTargets.length} ${deleteTargets.length === 1 ? 'account' : 'accounts'}?`;
    $('deleteSummary').textContent = 'Review the accounts selected for permanent deletion:';
    $('deleteList').replaceChildren();
    for (const token of deleteTargets) {
        const account = accounts.find(k => k.name === token);
        const li = document.createElement('li');
        li.textContent = `${account?.metadata.user || token} — ${account?.metadata.msEmail || 'No MS email'}`;
        $('deleteList').appendChild(li);
    }
    $('confirmDeleteBtn').textContent = `Delete ${deleteTargets.length} ${deleteTargets.length === 1 ? 'account' : 'accounts'}`;
    $('deleteDialog').showModal();
}
$('deleteDialog').addEventListener('cancel', event => { if (deleting) event.preventDefault(); });

async function confirmDelete() {
    if (deleting || !deleteTargets.length) return;
    deleting = true;
    for (const id of ['cancelDeleteBtn', 'confirmDeleteBtn', 'refreshBtn', 'selectBtn', 'accountSearch', 'accountSort', 'addBtn']) $(id).disabled = true;
    renderAccounts();
    const targets = [...deleteTargets], failed = [];
    let removed = 0;
    try {
        for (let offset = 0; offset < targets.length; offset += 100) {
            const batch = targets.slice(offset, offset + 100);
            $('confirmDeleteBtn').textContent = `Deleting ${offset + 1}–${offset + batch.length}…`;
            try {
                const result = await adminRequest('delete-tokens', { tokens: batch });
                if (!Array.isArray(result.deleted)) throw new Error('Deletion was not confirmed.');
                for (const id of batch) {
                    if (result.deleted.includes(id)) { deletedThisSession.add(id); selected.delete(id); removed++; }
                    else failed.push(id);
                }
            } catch (e) { failed.push(...batch); }
            if (offset + 100 < targets.length) await new Promise(resolve => setTimeout(resolve, 1100));
        }
        accounts = accounts.filter(k => !deletedThisSession.has(k.name));
        if (failed.length) {
            selecting = true; failed.forEach(id => selected.add(id));
            showErr(`${removed} deleted. ${failed.length} could not be confirmed and remain selected. Refresh to verify before retrying.`);
        } else showMsg(`${removed} ${removed === 1 ? 'account' : 'accounts'} permanently deleted.`);
        pollPending();
    } finally {
        deleting = false; deleteTargets = [];
        for (const id of ['cancelDeleteBtn', 'confirmDeleteBtn', 'refreshBtn', 'selectBtn', 'accountSearch', 'accountSort', 'addBtn']) $(id).disabled = false;
        $('deleteDialog').close(); renderAccounts();
    }
}

async function viewCode(id) {
    try {
        const d = await adminRequest(`view-code?token=${encodeURIComponent(id)}`);
        alert(`Code: ${d.code}\nExpires in: ${d.expiresIn}s\n\nBuyer: ${d.user}\nMS: ${d.msEmail || '?'}`);
    } catch (e) { showErr(e.message); }
}
window.viewCode = viewCode;
window.del = openDelete;

async function addToken() {
    const user = $('nUser').value.trim(), ms = $('nMs').value.trim(), secret = $('nSecret').value.trim();
    if (!user || !secret) return showErr('Buyer email / label and secret are required.');
    if ($('addBtn').disabled) return;
    $('addBtn').disabled = true;
    try {
        const data = await adminRequest('create-token', { user, secret, msEmail: ms || undefined });
        $('nUser').value = ''; $('nMs').value = ''; $('nSecret').value = '';
        await copy(`${SITE}/request.html?token=${encodeURIComponent(data.token)}`, 'Account added. Delivery link copied!');
        await fetchList();
    } catch (e) { showErr(e.message); }
    finally { $('addBtn').disabled = false; }
}
window.addToken = addToken;
async function copy(text, message = 'Delivery link copied!') {
    try { await navigator.clipboard.writeText(text); showMsg(message); }
    catch { prompt('Copy this delivery link:', text); }
}
window.copy = copy;
function showMsg(message) {
    clearTimeout(messageTimer); $('msg').textContent = message; $('msg').style.color = '#97ddb5';
    messageTimer = setTimeout(() => { $('msg').textContent = ''; }, 8000);
}
function showErr(message) {
    if ($('dashSec').classList.contains('active')) {
        clearTimeout(messageTimer); $('msg').textContent = message; $('msg').style.color = '#ff9c9c';
    } else $('err').textContent = message;
}
// Refresh relative-day labels on long-running pages, including after midnight.
setInterval(() => { if (auth && !deleting && !listLoading) renderAccounts(); }, 60000);
