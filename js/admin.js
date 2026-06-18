const API_BASE = "https://totp-backend.ibaddie.workers.dev";
const SITE_BASE = window.location.pathname.includes('/ibaddie-auth')
    ? `${window.location.origin}/ibaddie-auth`
    : window.location.origin;
let adminAuthToken = "";

const loginSec = document.getElementById('loginSection');
const dashboardSec = document.getElementById('dashboardSection');
const errorMsg = document.getElementById('errorMsg');
const dashboardMsg = document.getElementById('dashboardMsg');
const passInput = document.getElementById('adminPassword');
const tableBody = document.getElementById('tokenTableBody');

if (passInput) {
    passInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") attemptLogin();
    });
}

async function attemptLogin() {
    const pass = passInput.value.trim();
    if (!pass) return showErr("Password required");
    adminAuthToken = pass;
    try {
        const res = await fetch(`${API_BASE}/api/admin/list`, {
            headers: { 'Authorization': adminAuthToken }
        });
        if (res.ok) {
            loginSec.classList.remove('active');
            dashboardSec.classList.add('active');
            fetchList();
        } else {
            showErr("Incorrect password or unauthorized.");
        }
    } catch (e) {
        showErr("Network Error. Is the backend running?");
    }
}

async function fetchList() {
    if (!tableBody) return;
    tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center;">Loading...</td></tr>`;
    dashboardMsg.textContent = "";
    try {
        const res = await fetch(`${API_BASE}/api/admin/list`, {
            headers: { 'Authorization': adminAuthToken }
        });
        if (!res.ok) {
            if (res.status === 401) return location.reload();
            throw new Error("Failed to load list");
        }
        const data = await res.json();
        renderTable(data.keys || []);
    } catch (e) {
        dashboardMsg.style.color = "#ff4c4c";
        dashboardMsg.textContent = "Error: " + e.message;
    }
}

function formatTimeAgo(ts) {
    if (!ts) return 'never';
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
}

function formatLockout(until) {
    if (!until) return '—';
    const remaining = until - Date.now();
    if (remaining <= 0) return 'expired';
    const h = Math.floor(remaining / 3600000);
    const m = Math.floor((remaining % 3600000) / 60000);
    return `${h}h ${m}m`;
}

function renderTable(keys) {
    if (!tableBody) return;
    if (keys.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center;">No active tokens. Create one above!</td></tr>`;
        return;
    }
    tableBody.innerHTML = "";
    keys.forEach(k => {
        const meta = k.metadata || {};
        const user = meta.user || "Unknown";
        const uses = meta.usesLeft !== undefined ? meta.usesLeft : "?";
        const locked = meta.lockoutUntil && meta.lockoutUntil > Date.now();
        const hwidBound = meta.hwidBound ? "✅" : "❌";
        const lockoutStatus = locked
            ? `<span style="color:#ff4c4c;">LOCKED (${formatLockout(meta.lockoutUntil)})</span>`
            : '<span style="color:#4CAF50;">OK</span>';
        const url = `${SITE_BASE}/?token=${k.name}`;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>
                <strong>${user}</strong><br>
                <span style="font-size:0.75rem; color:#888;">${meta.msEmail || 'no MS email'}</span>
            </td>
            <td>${uses}/1</td>
            <td>${hwidBound}</td>
            <td>${lockoutStatus}</td>
            <td>
                <span style="font-size:0.75rem; color:#aaa;">
                    Last: ${formatTimeAgo(meta.lastIssuedAt)}
                </span>
            </td>
            <td><a class="copy-link" onclick="copyToClipboard('${url}')">Copy Link</a></td>
            <td>
                <button class="action-btn" style="margin: 2px; background: rgba(76, 175, 80, 0.2); color: #4CAF50; border-color: rgba(76, 175, 80, 0.5);" onclick="viewCode('${k.name}')">View Code</button>
                <button class="action-btn" style="margin: 2px;" onclick="resetToken('${k.name}')">Reset Uses</button>
                <button class="action-btn" style="margin: 2px;" onclick="resetHwid('${k.name}')">Reset HWID</button>
                <button class="action-btn" style="margin: 2px;" onclick="resetLockout('${k.name}')">Unlock</button>
                <button class="action-btn danger" style="margin: 2px;" onclick="deleteToken('${k.name}')">Delete</button>
            </td>
        `;
        tableBody.appendChild(tr);
    });
}

// ─── CREATE ACCOUNT (2 tokens for 1 MS account) ────────────────────────────────

async function createAccount() {
    const msEmail = document.getElementById('newMsEmail').value.trim();
    const secret = document.getElementById('newSecret').value.trim();
    const buyerAName = document.getElementById('buyerAName').value.trim();
    const buyerBName = document.getElementById('buyerBName').value.trim();
    const alertEmailsRaw = document.getElementById('alertEmails').value.trim();
    const alertEmails = alertEmailsRaw ? alertEmailsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

    if (!msEmail || !secret || !buyerAName || !buyerBName) {
        dashboardMsg.style.color = "#ff4c4c";
        dashboardMsg.textContent = "MS Email, Secret, Buyer A name, and Buyer B name are all required.";
        return;
    }

    dashboardMsg.style.color = "#4CAF50";
    dashboardMsg.textContent = "Generating 2 tokens...";

    try {
        const res = await fetch(`${API_BASE}/api/admin/create-account`, {
            method: 'POST',
            headers: {
                'Authorization': adminAuthToken,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                msEmail, secret, alertEmails,
                buyerA: { name: buyerAName },
                buyerB: { name: buyerBName }
            })
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || "Failed to create account");
        }

        const data = await res.json();
        const linkA = `${SITE_BASE}/?token=${data.buyerA.token}`;
        const linkB = `${SITE_BASE}/?token=${data.buyerB.token}`;

        const bothLinks = `Buyer A (${buyerAName}): ${linkA}\nBuyer B (${buyerBName}): ${linkB}`;
        copyToClipboard(bothLinks);

        dashboardMsg.style.color = "#4CAF50";
        dashboardMsg.innerHTML = `✅ Account created! Both buyer links copied to clipboard.<br>
            <strong>Buyer A (${buyerAName}):</strong> <a href="${linkA}" target="_blank" style="color:#FFD700;">${linkA}</a><br>
            <strong>Buyer B (${buyerBName}):</strong> <a href="${linkB}" target="_blank" style="color:#FFD700;">${linkB}</a>`;

        document.getElementById('newMsEmail').value = '';
        document.getElementById('newSecret').value = '';
        document.getElementById('buyerAName').value = '';
        document.getElementById('buyerBName').value = '';
        document.getElementById('alertEmails').value = '';

        fetchList();
    } catch (e) {
        dashboardMsg.style.color = "#ff4c4c";
        dashboardMsg.textContent = "Error: " + e.message;
    }
}

// ─── LEGACY: CREATE SINGLE TOKEN ───────────────────────────────────────────────

async function createToken() {
    const user = document.getElementById('singleUsername').value.trim();
    const secret = document.getElementById('singleSecret').value.trim();
    if (!user || !secret) {
        dashboardMsg.style.color = "#ff4c4c";
        dashboardMsg.textContent = "Both Username and Secret required.";
        return;
    }
    dashboardMsg.style.color = "#4CAF50";
    dashboardMsg.textContent = "Generating...";
    try {
        const res = await fetch(`${API_BASE}/api/admin/create-token`, {
            method: 'POST',
            headers: {
                'Authorization': adminAuthToken,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ user, secret })
        });
        if (!res.ok) throw new Error("Failed to create token");
        const data = await res.json();
        document.getElementById('singleUsername').value = '';
        document.getElementById('singleSecret').value = '';
        const fullUrl = `${SITE_BASE}/?token=${data.token}`;
        copyToClipboard(fullUrl);
        dashboardMsg.style.color = "#4CAF50";
        dashboardMsg.textContent = "Single token generated and link copied!";
        fetchList();
    } catch (e) {
        dashboardMsg.style.color = "#ff4c4c";
        dashboardMsg.textContent = "Error: " + e.message;
    }
}

// ─── TOKEN ACTIONS ─────────────────────────────────────────────────────────────

async function deleteToken(tokenId) {
    if (!confirm("Delete this token permanently? Customer loses code access.")) return;
    try {
        const res = await fetch(`${API_BASE}/api/admin/delete-token`, {
            method: 'POST',
            headers: { 'Authorization': adminAuthToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: tokenId })
        });
        if (!res.ok) throw new Error("Failed to delete");
        fetchList();
    } catch (e) { alert("Error: " + e.message); }
}

// View a token's current TOTP code directly from the admin dashboard.
// Does NOT affect the buyer's quota or cooldown — admin-only view.
async function viewCode(tokenId) {
    try {
        const res = await fetch(`${API_BASE}/api/admin/view-code?token=${encodeURIComponent(tokenId)}`, {
            headers: { 'Authorization': adminAuthToken }
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || "Failed to fetch code");
        }
        const data = await res.json();
        const lockoutWarning = data.locked ? `\n⚠️ Token is LOCKED (${data.lockoutReason}). Code may still work for testing.` : '';
        const hwidStatus = data.hwidBound ? 'HWID bound (buyer has activated)' : 'HWID not bound (no buyer yet)';
        const lastIssued = data.lastIssuedAt ? new Date(data.lastIssuedAt).toLocaleString() : 'never';
        alert(
            `Code: ${data.code}\n` +
            `Expires in: ${data.expiresIn}s\n\n` +
            `User: ${data.user}\n` +
            `MS Email: ${data.msEmail || 'unknown'}\n` +
            `HWID: ${hwidStatus}\n` +
            `Uses left: ${data.usesLeft}/1\n` +
            `Buyer's last code: ${lastIssued}${lockoutWarning}\n\n` +
            `✅ This view did NOT affect the buyer's quota or cooldown.`
        );
    } catch (e) {
        alert("Error: " + e.message);
    }
}

async function resetToken(tokenId) {
    if (!confirm("Reset uses back to 1/1?")) return;
    try {
        const res = await fetch(`${API_BASE}/api/admin/reset-token`, {
            method: 'POST',
            headers: { 'Authorization': adminAuthToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: tokenId })
        });
        if (!res.ok) throw new Error("Failed to reset");
        fetchList();
    } catch (e) { alert("Error: " + e.message); }
}

async function resetHwid(tokenId) {
    if (!confirm("Reset HWID binding? This allows the customer to log in from a new device. Allowed once every 7 days.")) return;
    try {
        const res = await fetch(`${API_BASE}/api/admin/reset-hwid`, {
            method: 'POST',
            headers: { 'Authorization': adminAuthToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: tokenId })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || "Failed to reset HWID");
        }
        fetchList();
    } catch (e) { alert("Error: " + e.message); }
}

async function resetLockout(tokenId) {
    if (!confirm("Clear lockout and re-enable this token?")) return;
    try {
        const res = await fetch(`${API_BASE}/api/admin/reset-lockout`, {
            method: 'POST',
            headers: { 'Authorization': adminAuthToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: tokenId })
        });
        if (!res.ok) throw new Error("Failed to clear lockout");
        fetchList();
    } catch (e) { alert("Error: " + e.message); }
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        dashboardMsg.style.color = "#FFD700";
        dashboardMsg.textContent = "Copied to clipboard!";
        setTimeout(() => { if (dashboardMsg.textContent === "Copied to clipboard!") dashboardMsg.textContent = ""; }, 3000);
    }).catch(() => alert("Manual copy:\n" + text));
}

function showErr(msg) { if (errorMsg) errorMsg.textContent = msg; }

function togglePassword() {
    const input = document.getElementById('adminPassword');
    const eyeIcon = document.getElementById('eyeIcon');
    const eyeOffIcon = document.getElementById('eyeOffIcon');
    if (input.type === 'password') {
        input.type = 'text';
        eyeIcon.style.display = 'none';
        eyeOffIcon.style.display = 'block';
    } else {
        input.type = 'password';
        eyeIcon.style.display = 'block';
        eyeOffIcon.style.display = 'none';
    }
}

// Expose for inline onclick handlers
window.attemptLogin = attemptLogin;
window.fetchList = fetchList;
window.createAccount = createAccount;
window.createToken = createToken;
window.deleteToken = deleteToken;
window.viewCode = viewCode;
window.resetToken = resetToken;
window.resetHwid = resetHwid;
window.resetLockout = resetLockout;
window.copyToClipboard = copyToClipboard;
window.togglePassword = togglePassword;
