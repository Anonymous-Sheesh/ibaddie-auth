// ══════════════════════════════════════════════════════════════════════════════
// admin.js — V3.1 (background-tab-safe heartbeat + notification sound)
// ══════════════════════════════════════════════════════════════════════════════

const API = "https://totp-backend.ibaddie.workers.dev";
const SITE = window.location.origin + window.location.pathname.replace('/admin.html', '');
let auth = "";
const $ = id => document.getElementById(id);

let lastPendingCount = 0;

// ─── NOTIFICATION SOUND ────────────────────────────────────────────────────────
// Plays a beep using Web Audio API (no external file needed)
let audioCtx = null;
function playNotificationSound() {
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.frequency.value = 880;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.5);
        // Second beep after 200ms
        setTimeout(() => {
            try {
                const osc2 = audioCtx.createOscillator();
                const gain2 = audioCtx.createGain();
                osc2.connect(gain2); gain2.connect(audioCtx.destination);
                osc2.frequency.value = 1320;
                osc2.type = 'sine';
                gain2.gain.setValueAtTime(0.3, audioCtx.currentTime);
                gain2.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
                osc2.start(audioCtx.currentTime);
                osc2.stop(audioCtx.currentTime + 0.5);
            } catch {}
        }, 200);
    } catch {}
}

// ─── LOGIN ─────────────────────────────────────────────────────────────────────
function login() {
    const p = $('pw').value.trim();
    if (!p) return showErr("Password required");
    auth = p;
    fetch(`${API}/api/admin/list`, { headers: { Authorization: auth } })
        .then(r => { if (r.ok) { $('loginSec').classList.remove('active'); $('dashSec').classList.add('active'); startHeartbeat(); startPending(); fetchList(); } else showErr("Wrong password"); })
        .catch(() => showErr("Network error"));
}
window.login = login;

function togglePw() { const i = $('pw'); i.type = i.type === 'password' ? 'text' : 'password'; }
window.togglePw = togglePw;

function logout() {
    fetch(`${API}/api/admin/go-offline`, { method: 'POST', headers: { Authorization: auth } }).catch(() => {});
    stopHeartbeat(); stopPending();
    auth = "";
    location.reload();
}
window.logout = logout;

// ─── BEFORE UNLOAD: go offline via fetch keepalive ─────────────────────────────
window.addEventListener('beforeunload', () => {
    if (auth) {
        fetch(`${API}/api/admin/go-offline`, { method: 'POST', headers: { Authorization: auth }, keepalive: true }).catch(() => {});
    }
});

// ─── VISIBILITY CHANGE: send heartbeat immediately when tab becomes visible ────
// This compensates for browser throttling of setInterval in background tabs.
// When the admin switches back to the tab, we immediately send a heartbeat so
// the buyer sees "online" within seconds.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && auth) {
        beat(); // immediate heartbeat
        pollPending(); // immediate poll
    }
});

// ─── HEARTBEAT (3s when visible, survives background throttling) ───────────────
let hbTimer = null;
function startHeartbeat() {
    stopHeartbeat();
    beat();
    // 3s interval — even with browser throttling (which may push it to 10-15s
    // in background), the 30s threshold in the worker means admin stays "online"
    hbTimer = setInterval(beat, 3000);
}
function stopHeartbeat() { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } }
async function beat() { try { await fetch(`${API}/api/admin/heartbeat`, { method: 'POST', headers: { Authorization: auth } }); } catch {} }

// ─── PENDING REQUESTS (3s when visible) ────────────────────────────────────────
let pTimer = null;
function startPending() { stopPending(); pollPending(); pTimer = setInterval(pollPending, 3000); }
function stopPending() { if (pTimer) { clearInterval(pTimer); pTimer = null; } }

async function pollPending() {
    try {
        const r = await fetch(`${API}/api/admin/pending`, { headers: { Authorization: auth } });
        if (!r.ok) return;
        const d = await r.json();
        const pending = d.pending || [];

        // Notification sound: if new requests arrived AND tab is not focused
        if (pending.length > lastPendingCount && document.visibilityState !== 'visible') {
            playNotificationSound();
        }
        lastPendingCount = pending.length;

        renderPending(pending);
    } catch {}
}

function renderPending(pending) {
    $('pCount').textContent = pending.length;
    const c = $('pList');
    if (!pending.length) { c.innerHTML = '<p style="color:#707080;font-size:0.82rem;text-align:center;padding:0.8rem 0;">No pending requests</p>'; return; }
    c.innerHTML = '';
    pending.forEach(r => {
        const ago = r.timeAgo < 60 ? `${r.timeAgo}s ago` : `${Math.floor(r.timeAgo / 60)}m ago`;
        const st = r.status === 'request_fresh' ? '🔄 Fresh requested' : '⏳ Pending';
        const card = document.createElement('div');
        card.className = 'req-card';
        card.innerHTML = `
            <div class="req-info"><div><strong>${r.buyerUser}</strong><br><span>MS: ${r.msEmail||'?'} · ${ago}</span></div><span style="font-size:0.72rem;color:${r.status==='request_fresh'?'#FFA500':'#4CAF50'};">${st}</span></div>
            <div id="img-${r.requestId}" style="margin-bottom:10px;"><button class="act-btn view" onclick="loadScreenshot('${r.requestId}')">📸 View Screenshot</button></div>
            <div class="req-btns">
                <button class="req-btn approve" onclick="approve('${r.requestId}')">✓ Approve</button>
                <button class="req-btn reject" onclick="reject('${r.requestId}')">✗ Reject</button>
                <button class="req-btn fresh" onclick="fresh('${r.requestId}')">🔄 Ask Fresh</button>
            </div>`;
        c.appendChild(card);
    });
}

// ─── LOAD SCREENSHOT ON DEMAND ─────────────────────────────────────────────────
async function loadScreenshot(requestId) {
    const container = $('img-' + requestId);
    if (!container) return;
    container.innerHTML = '<p style="color:#808090;font-size:0.78rem;">Loading screenshot...</p>';
    try {
        const r = await fetch(`${API}/api/admin/pending-screenshot?requestId=${requestId}`, { headers: { Authorization: auth } });
        if (!r.ok) throw new Error('Failed');
        const d = await r.json();
        container.innerHTML = `<img class="req-img" src="${d.screenshot}" onclick="window.open('${d.screenshot}')">`;
    } catch (e) {
        container.innerHTML = '<p style="color:#ff4c4c;font-size:0.78rem;">Failed to load</p>';
    }
}
window.loadScreenshot = loadScreenshot;

async function approve(id) {
    try {
        const r = await fetch(`${API}/api/admin/approve`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: id }) });
        if (!r.ok) throw new Error('Failed');
        const d = await r.json();
        showMsg(`✅ Code ${d.code} sent (expires ${d.expiresIn}s)`);
        pollPending();
    } catch (e) { alert('Error: ' + e.message); }
}
window.approve = approve;

async function reject(id) {
    const reason = prompt('Rejection reason:', 'This doesn\'t show a Minecraft launcher. Please follow the guide.');
    if (reason === null) return;
    try {
        const r = await fetch(`${API}/api/admin/reject`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: id, reason }) });
        if (!r.ok) throw new Error('Failed');
        showMsg('✗ Rejected');
        pollPending();
    } catch (e) { alert('Error: ' + e.message); }
}
window.reject = reject;

async function fresh(id) {
    try {
        const r = await fetch(`${API}/api/admin/request-fresh`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: id }) });
        if (!r.ok) throw new Error('Failed');
        showMsg('🔄 Buyer asked for fresh screenshot');
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
        tr.innerHTML = `<td><strong>${m.user||'?'}</strong>${m.hasPending?'<br><span style="color:#ff4c4c;font-size:0.72rem;">⏳ Has pending request</span>':''}</td>
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
    try {
        const r = await fetch(`${API}/api/admin/create-token`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ user, secret, msEmail: ms || undefined }) });
        if (!r.ok) throw new Error('Failed');
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

function showMsg(m) { $('msg').textContent = m; $('msg').style.color = '#4CAF50'; setTimeout(() => { if (($('msg').textContent||'').startsWith('✅')||($('msg').textContent||'').startsWith('✗')||($('msg').textContent||'').startsWith('🔄')||($('msg').textContent||'').startsWith('📋')) $('msg').textContent=''; }, 4000); }
function showErr(m) { $('err').textContent = m; }
