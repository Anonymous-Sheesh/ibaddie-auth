// ══════════════════════════════════════════════════════════════════════════════
// admin.js — V3.2 (screenshots inline, cards auto-remove, sound on new)
// ══════════════════════════════════════════════════════════════════════════════

const API = "https://totp-backend.ibaddie.workers.dev";
const SITE = window.location.origin + window.location.pathname.replace('/admin.html', '');
let auth = "";
const $ = id => document.getElementById(id);
let lastPendingIds = new Set();

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
    if (document.visibilityState === 'visible' && auth) { beat(); pollPending(); }
});

// ─── HEARTBEAT ─────────────────────────────────────────────────────────────────
let hbTimer = null;
function startHeartbeat() { stopHeartbeat(); beat(); hbTimer = setInterval(beat, 3000); }
function stopHeartbeat() { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } }
async function beat() { try { await fetch(`${API}/api/admin/heartbeat`, { method: 'POST', headers: { Authorization: auth } }); } catch {} }

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
    const c = $('pList');
    if (!pending.length) {
        c.innerHTML = '<p style="color:#707080;font-size:0.82rem;text-align:center;padding:0.8rem 0;">No pending requests</p>';
        return;
    }
    c.innerHTML = '';
    pending.forEach(r => {
        const ago = r.timeAgo < 60 ? `${r.timeAgo}s ago` : `${Math.floor(r.timeAgo / 60)}m ago`;
        const st = r.status === 'request_fresh' ? '🔄 Fresh requested' : '⏳ Pending';
        const card = document.createElement('div');
        card.className = 'req-card';
        card.id = 'card-' + r.requestId;
        card.innerHTML = `
            <div class="req-info"><div><strong>${r.buyerUser}</strong><br><span>MS: ${r.msEmail||'?'} · ${ago}</span></div><span style="font-size:0.72rem;color:${r.status==='request_fresh'?'#FFA500':'#4CAF50'};">${st}</span></div>
            <img class="req-img" src="${r.screenshot}" onclick="window.open('${r.screenshot}')">
            <div class="req-btns">
                <button class="req-btn approve" onclick="approve('${r.requestId}')">✓ Approve</button>
                <button class="req-btn reject" onclick="reject('${r.requestId}')">✗ Reject</button>
                <button class="req-btn fresh" onclick="fresh('${r.requestId}')">🔄 Ask Fresh</button>
            </div>`;
        c.appendChild(card);
    });
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

// ─── TOKEN LIST ────────────────────────────────────────────────────────────────
async function fetchList() {
    $('tbl').innerHTML = '<tr><td colspan="4" style="text-align:center;">Loading...</td></tr>';
    try {
        const r = await fetch(`${API}/api/admin/list`, { headers: { Authorization: auth } });
        if (!r.ok) { if (r.status === 401) return location.reload(); throw new Error('Failed'); }
        const d = await r.json();
        render(d.keys || []);
    } catch (e) { showErr('Error: ' + e.message); }
}
window.fetchList = fetchList;

function render(keys) {
    if (!keys.length) { $('tbl').innerHTML = '<tr><td colspan="4" style="text-align:center;">No accounts yet</td></tr>'; return; }
    const sorted = [...keys].sort((a, b) => ((b.metadata||{}).createdAt||0) - ((a.metadata||{}).createdAt||0));
    $('tbl').innerHTML = '';
    sorted.forEach(k => {
        const m = k.metadata || {};
        const link = `${SITE}/request.html?token=${k.name}`;
        const tr = document.createElement('tr');
        tr.innerHTML = `<td><strong>${m.user||'?'}</strong>${m.hasPending?'<br><span style="color:#ff4c4c;font-size:0.72rem;">⏳ Pending request</span>':''}</td>
            <td><span class="meta">${m.msEmail||'—'}</span></td>
            <td><a class="copy-link" onclick="copy('${link}')">Copy Link</a></td>
            <td><button class="act-btn view" onclick="viewCode('${k.name}')">View Code</button><button class="act-btn danger" onclick="del('${k.name}')">Delete</button></td>`;
        $('tbl').appendChild(tr);
    });
}

async function viewCode(id) {
    try {
        const r = await fetch(`${API}/api/admin/view-code?token=${id}`, { headers: { Authorization: auth } });
        if (!r.ok) throw new Error('Failed');
        const d = await r.json();
        alert(`Code: ${d.code}\nExpires in: ${d.expiresIn}s\n\nBuyer: ${d.user}\nMS: ${d.msEmail||'?'}`);
    } catch (e) { alert('Error: ' + e.message); }
}
window.viewCode = viewCode;

async function del(id) {
    if (!confirm('Delete this account permanently?')) return;
    try { await fetch(`${API}/api/admin/delete-token`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: id }) }); fetchList(); }
    catch (e) { alert('Error: ' + e.message); }
}
window.del = del;

async function addToken() {
    const user = $('nUser').value.trim(), ms = $('nMs').value.trim(), secret = $('nSecret').value.trim();
    if (!user || !secret) return showErr('Buyer email + secret required');
    showMsg('Generating...');
    try {
        const r = await fetch(`${API}/api/admin/create-token`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ user, secret, msEmail: ms || undefined }) });
        if (!r.ok) {
            const errData = await r.json().catch(() => ({}));
            throw new Error(errData.error || 'status ' + r.status);
        }
        const d = await r.json();
        const link = `${SITE}/request.html?token=${d.token}`;
        copy(link);
        showMsg('✅ Link generated & copied!');
        $('nUser').value = ''; $('nMs').value = ''; $('nSecret').value = '';
        fetchList();
    } catch (e) { showErr('Error: ' + e.message); }
}
window.addToken = addToken;

function copy(text) { navigator.clipboard.writeText(text).then(() => { showMsg('📋 Copied!'); setTimeout(() => { if (($('msg').textContent||'').startsWith('📋')) $('msg').textContent = ''; }, 2000); }).catch(() => alert(text)); }
window.copy = copy;

function showMsg(m) { $('msg').textContent = m; $('msg').style.color = '#4CAF50'; setTimeout(() => { $('msg').textContent=''; }, 4000); }
function showErr(m) { $('err').textContent = m; }
