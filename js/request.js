// ══════════════════════════════════════════════════════════════════════════════
// request.js — Buyer Code Request Logic (V3.1 — fresh code + click-to-copy)
// ══════════════════════════════════════════════════════════════════════════════

const API = "https://totp-backend.ibaddie.workers.dev";
const $ = id => document.getElementById(id);

let token = null;
let uploading = false;
let statusTimer = null;
let codeTimer = null;
let presenceTimer = null;
let pendingCountdownTimer = null;
let currentCode = null;

// ─── INIT ──────────────────────────────────────────────────────────────────────
const url = new URL(window.location.href);
token = url.searchParams.get('token') || url.searchParams.get('t');
if (!token) {
    $('reqBtn').style.display = 'none';
    $('badge').style.display = 'none';
    $('waitArea').style.display = 'block';
    $('waitText').textContent = 'No valid token. Use the link from your delivery message.';
} else {
    $('reqBtn').disabled = false;
    checkPresence();
    presenceTimer = setInterval(checkPresence, 5000);
    checkExisting();
}

// ─── PRESENCE ──────────────────────────────────────────────────────────────────
async function checkPresence() {
    try {
        const r = await fetch(`${API}/api/presence`);
        const d = await r.json();
        const b = $('badge');
        b.style.display = 'inline-flex';
        if (d.online) {
            b.className = 'badge badge-on';
            $('badgeText').textContent = 'Ibaddie is online';
        } else {
            b.className = 'badge badge-off';
            $('badgeText').textContent = 'Ibaddie is offline — request will be queued';
        }
    } catch { $('badge').style.display = 'none'; }
}

// ─── REQUEST BUTTON ────────────────────────────────────────────────────────────
$('reqBtn').addEventListener('click', () => {
    hideAll();
    $('uploadArea').style.display = 'block';
});

$('uploadArea').addEventListener('click', () => { if (!uploading) $('fileInput').click(); });

$('fileInput').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (f) await upload(f);
});

async function upload(file) {
    if (uploading || !token) return;
    uploading = true;
    $('uploadArea').style.display = 'none';
    $('waitArea').style.display = 'block';
    $('waitText').textContent = 'Uploading screenshot...';

    try {
        const compressed = await compress(file);
        if (!compressed) throw new Error('Image failed to process');

        const r = await fetch(`${API}/api/code-request`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, screenshot: compressed })
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Failed');
        $('waitText').textContent = 'Waiting for Ibaddie to review...';
        startPolling();
    } catch (e) {
        $('waitArea').style.display = 'none';
        $('reqBtn').style.display = 'block';
        $('reqBtn').disabled = false;
        alert('Error: ' + e.message);
    } finally { uploading = false; }
}

// ─── IMAGE COMPRESS ────────────────────────────────────────────────────────────
function compress(file) {
    return new Promise(res => {
        const r = new FileReader();
        r.onload = e => {
            const img = new Image();
            img.onload = () => {
                const c = document.createElement('canvas');
                const s = Math.min(1, 800 / img.width);
                c.width = img.width * s; c.height = img.height * s;
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                res(c.toDataURL('image/jpeg', 0.7));
            };
            img.onerror = () => res(null);
            img.src = e.target.result;
        };
        r.onerror = () => res(null);
        r.readAsDataURL(file);
    });
}

// ─── STATUS POLLING (2s) ───────────────────────────────────────────────────────
function startPolling() { stopPolling(); poll(); statusTimer = setInterval(poll, 2000); }
function stopPolling() { if (statusTimer) { clearInterval(statusTimer); statusTimer = null; } }

async function poll() {
    if (!token) return;
    try {
        const r = await fetch(`${API}/api/code-request/status?token=${token}`);
        const d = await r.json();

        if (d.status === 'none' || d.status === 'expired') {
            stopPolling(); stopPendingCountdown(); hideAll();
            $('reqBtn').style.display = 'block'; $('reqBtn').disabled = false;
            if (d.status === 'expired') {
                $('waitArea').style.display='block';
                $('waitText').textContent='Code expired. Request a new one.';
                setTimeout(()=>{$('waitArea').style.display='none';},2000);
            }
            return;
        }
        if (d.status === 'pending') {
            stopPendingCountdown();
            hideAll(); $('waitArea').style.display='block';
            $('waitText').textContent='Waiting for Ibaddie to review...';
        }
        else if (d.status === 'approved_pending') {
            // Admin approved but code needs to wait for fresh window
            // Show "Showing code in X..." countdown
            hideAll();
            $('codeBox').style.display = 'block';
            $('codeNum').textContent = '······';
            $('codeNum').style.color = '#ff4c4c';
            $('codeNum').style.cursor = 'default';
            currentCode = null;
            const waitSecs = d.waitSeconds || 5;
            $('codeTimer').textContent = `Showing code in ${waitSecs}s...`;
            startPendingCountdown(waitSecs);
        }
        else if (d.status === 'approved' && d.code) {
            stopPendingCountdown();
            hideAll();
            $('codeBox').style.display = 'block';
            $('codeNum').textContent = d.code;
            $('codeNum').style.color = '#FFD700';
            $('codeNum').style.cursor = 'pointer';
            currentCode = d.code;
            startCountdown(d.codeExpiresIn || 30);
        }
        else if (d.status === 'request_fresh') {
            stopPendingCountdown();
            stopPolling(); hideAll();
            $('uploadArea').style.display='block'; $('fileInput').value='';
        }
        else if (d.status === 'rejected') {
            stopPendingCountdown();
            stopPolling(); hideAll();
            $('rejectBox').style.display = 'block';
            $('rejectReason').textContent = d.rejectionReason || 'Please follow the guide and try again.';
            // Show a "Try Again" button below the rejection — stays until buyer clicks it
            if (!$('tryAgainBtn')) {
                const btn = document.createElement('button');
                btn.id = 'tryAgainBtn';
                btn.className = 'big-btn';
                btn.style.marginTop = '1rem';
                btn.textContent = '🔄 Try Again';
                btn.onclick = () => {
                    $('rejectBox').style.display = 'none';
                    btn.remove();
                    $('reqBtn').style.display = 'block';
                    $('reqBtn').disabled = false;
                };
                $('rejectBox').parentNode.insertBefore(btn, $('rejectBox').nextSibling);
            }
        }
    } catch {}
}

// ─── PENDING COUNTDOWN (for approved_pending "Showing code in X...") ────────────
function startPendingCountdown(secs) {
    stopPendingCountdown();
    let left = secs;
    $('codeTimer').textContent = `Showing code in ${left}s...`;
    pendingCountdownTimer = setInterval(() => {
        left--;
        if (left <= 0) {
            stopPendingCountdown();
            // Force immediate poll to get the fresh code
            poll();
            return;
        }
        $('codeTimer').textContent = `Showing code in ${left}s...`;
    }, 1000);
}
function stopPendingCountdown() { if (pendingCountdownTimer) { clearInterval(pendingCountdownTimer); pendingCountdownTimer = null; } }

// ─── CODE COUNTDOWN ────────────────────────────────────────────────────────────
function startCountdown(s) {
    if (codeTimer) clearInterval(codeTimer);
    let left = s;
    $('codeTimer').textContent = `Expires in ${left}s`;
    codeTimer = setInterval(() => {
        if (--left <= 0) {
            clearInterval(codeTimer);
            $('codeBox').style.display = 'none';
            $('codeNum').textContent = '000000';
            currentCode = null;
            $('waitArea').style.display = 'block';
            $('waitText').textContent = 'Code expired. Request a new one.';
            $('reqBtn').style.display = 'block'; $('reqBtn').disabled = false;
            return;
        }
        $('codeTimer').textContent = `Expires in ${left}s`;
    }, 1000);
}

// ─── CLICK TO COPY ─────────────────────────────────────────────────────────────
$('codeNum').addEventListener('click', () => {
    if (!currentCode) return;
    navigator.clipboard.writeText(currentCode).then(() => {
        const orig = $('codeNum').style.color;
        $('codeNum').style.color = '#4CAF50';
        setTimeout(() => { $('codeNum').style.color = orig; }, 500);
    }).catch(() => {});
});

// ─── CANCEL ────────────────────────────────────────────────────────────────────
async function cancelRequest() {
    if (!token) return;
    try { await fetch(`${API}/api/code-request/withdraw`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token}) }); } catch {}
    stopPolling(); stopPendingCountdown(); hideAll();
    $('reqBtn').style.display = 'block'; $('reqBtn').disabled = false;
}
window.cancelRequest = cancelRequest;

// ─── CHECK EXISTING ON LOAD ────────────────────────────────────────────────────
async function checkExisting() {
    if (!token) return;
    try {
        const r = await fetch(`${API}/api/code-request/status?token=${token}`);
        const d = await r.json();
        if (d.status === 'pending') { hideAll(); $('reqBtn').style.display='none'; startPolling(); }
        else if (d.status === 'approved_pending') { hideAll(); $('reqBtn').style.display='none'; $('codeBox').style.display='block'; $('codeNum').textContent='······'; $('codeNum').style.color='#ff4c4c'; startPendingCountdown(d.waitSeconds||5); startPolling(); }
        else if (d.status === 'approved' && d.code && d.codeExpiresIn > 0) { hideAll(); $('reqBtn').style.display='none'; $('codeBox').style.display='block'; $('codeNum').textContent=d.code; $('codeNum').style.color='#FFD700'; currentCode=d.code; startCountdown(d.codeExpiresIn); }
        else if (d.status === 'rejected') {
            hideAll(); $('reqBtn').style.display='none';
            $('rejectBox').style.display='block';
            $('rejectReason').textContent=d.rejectionReason||'Try again.';
            if (!$('tryAgainBtn')) {
                const btn = document.createElement('button');
                btn.id = 'tryAgainBtn';
                btn.className = 'big-btn';
                btn.style.marginTop = '1rem';
                btn.textContent = '🔄 Try Again';
                btn.onclick = () => {
                    $('rejectBox').style.display = 'none';
                    btn.remove();
                    $('reqBtn').style.display = 'block';
                    $('reqBtn').disabled = false;
                };
                $('rejectBox').parentNode.insertBefore(btn, $('rejectBox').nextSibling);
            }
        }
    } catch {}
}

function hideAll() {
    $('reqBtn').style.display = 'none';
    $('uploadArea').style.display = 'none';
    $('waitArea').style.display = 'none';
    $('codeBox').style.display = 'none';
    $('rejectBox').style.display = 'none';
    // Remove Try Again button if it exists
    const tab = $('tryAgainBtn');
    if (tab) tab.remove();
}
