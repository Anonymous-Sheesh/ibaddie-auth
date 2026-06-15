// Configuration
const API_BASE = "https://totp-backend.ibaddie.workers.dev";
const SITE_BASE = window.location.pathname.includes('/ibaddie-auth')
    ? `${window.location.origin}/ibaddie-auth` 
    : window.location.origin;
let adminAuthToken = "";

// UI Elements
const loginSec = document.getElementById('loginSection');
const dashboardSec = document.getElementById('dashboardSection');
const errorMsg = document.getElementById('errorMsg');
const dashboardMsg = document.getElementById('dashboardMsg');
const passInput = document.getElementById('adminPassword');
const tableBody = document.getElementById('tokenTableBody');

// Intercept Enter key
passInput.addEventListener("keypress", (e) => {
    if(e.key === "Enter") attemptLogin();
});

async function attemptLogin() {
    const pass = passInput.value.trim();
    if(!pass) return showErr("Password required");
    
    // We test the password by attempting to list
    adminAuthToken = pass;
    try {
        const res = await fetch(`${API_BASE}/api/admin/list`, {
            headers: { 'Authorization': adminAuthToken }
        });
        
        if(res.ok) {
            loginSec.classList.remove('active');
            dashboardSec.classList.add('active');
            fetchList();
        } else {
            showErr("Incorrect password or unauthorized.");
        }
    } catch(e) {
        showErr("Network Error. Is the backend running?");
    }
}

async function fetchList() {
    tableBody.innerHTML = `<tr><td colspan="4" style="text-align:center;">Loading...</td></tr>`;
    dashboardMsg.textContent = "";

    try {
        const res = await fetch(`${API_BASE}/api/admin/list`, {
            headers: { 'Authorization': adminAuthToken }
        });
        
        if(!res.ok) {
            if(res.status === 401) return location.reload(); // Booted
            throw new Error("Failed to load list");
        }

        const data = await res.json();
        renderTable(data.keys || []);
    } catch(e) {
        dashboardMsg.style.color = "#ff4c4c";
        dashboardMsg.textContent = "Error: " + e.message;
    }
}

function renderTable(keys) {
    if(keys.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="4" style="text-align:center;">No active accounts. Create one above!</td></tr>`;
        return;
    }

    tableBody.innerHTML = "";
    keys.forEach(k => {
        // kv metadata format
        const meta = k.metadata || {};
        const user = meta.user || "Unknown";
        const uses = meta.usesLeft !== undefined ? meta.usesLeft : "?";
        
        // We know the id is k.name, so build the url
        // Uses the current frontend host, not the backend host
        const url = `${SITE_BASE}/?token=${k.name}`;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${user}</strong></td>
            <td>${uses}/1</td>
            <td><a class="copy-link" onclick="copyToClipboard('${url}')">Copy Link</a></td>
            <td>
                <button class="action-btn" style="margin-right: 5px;" onclick="resetToken('${k.name}')">Reset</button>
                <button class="action-btn" onclick="deleteToken('${k.name}')">Delete</button>
            </td>
        `;
        tableBody.appendChild(tr);
    });
}

async function createToken() {
    const user = document.getElementById('newUsername').value.trim();
    const secret = document.getElementById('newSecret').value.trim();

    if(!user || !secret) {
        dashboardMsg.style.color = "#ff4c4c";
        dashboardMsg.textContent = "Please provide both Username and Secret.";
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
        
        if(!res.ok) throw new Error("Failed to create token");
        
        const data = await res.json();
        
        document.getElementById('newUsername').value = '';
        document.getElementById('newSecret').value = '';
        dashboardMsg.style.color = "#4CAF50";
        dashboardMsg.textContent = "Link generated! Customer token is live.";
        
        // Copy to clipboard immediately
        const fullUrl = `${SITE_BASE}/?token=${data.token}`;
        copyToClipboard(fullUrl);

        fetchList(); // reload table
    } catch(e) {
        dashboardMsg.style.color = "#ff4c4c";
        dashboardMsg.textContent = "Error: " + e.message;
    }
}

async function deleteToken(tokenId) {
    if(!confirm("Are you sure you want to revoke this delivery link? The customer will no longer be able to get codes.")) return;

    try {
        const res = await fetch(`${API_BASE}/api/admin/delete-token`, {
            method: 'POST',
            headers: { 
                'Authorization': adminAuthToken,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ token: tokenId })
        });
        
        if(!res.ok) throw new Error("Failed to delete token");
        
        fetchList();
    } catch(e) {
        alert("Error deleting: " + e.message);
    }
}

async function resetToken(tokenId) {
    if(!confirm("Reset uses back to 1/1 for this token?")) return;

    try {
        const res = await fetch(`${API_BASE}/api/admin/reset-token`, {
            method: 'POST',
            headers: { 
                'Authorization': adminAuthToken,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ token: tokenId })
        });
        
        if(!res.ok) throw new Error("Failed to reset token");
        
        fetchList();
    } catch(e) {
        alert("Error resetting: " + e.message);
    }
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        dashboardMsg.style.color = "#FFD700";
        dashboardMsg.textContent = "Copied link to clipboard!";
        setTimeout(() => dashboardMsg.textContent="", 3000);
    }).catch(() => {
        alert("Link (manual copy): \n" + text);
    });
}

function showErr(msg) {
    errorMsg.textContent = msg;
}

function togglePassword() {
    const input = document.getElementById('adminPassword');
    const eyeIcon = document.getElementById('eyeIcon');
    const eyeOffIcon = document.getElementById('eyeOffIcon');
    if(input.type === 'password') {
        input.type = 'text';
        eyeIcon.style.display = 'none';
        eyeOffIcon.style.display = 'block';
    } else {
        input.type = 'password';
        eyeIcon.style.display = 'block';
        eyeOffIcon.style.display = 'none';
    }
}
