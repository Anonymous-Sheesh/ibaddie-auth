// ══════════════════════════════════════════════════════════════════════════════
// request.js — Buyer's Code Request Logic
// ══════════════════════════════════════════════════════════════════════════════

const API_BASE = "https://totp-backend.ibaddie.workers.dev";

const presenceBadge = document.getElementById('presenceBadge');
const presenceText = document.getElementById('presenceText');
const requestBtn = document.getElementById('requestBtn');
const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const statusBox = document.getElementById('statusBox');
const statusText = document.getElementById('statusText');
const codeDisplay = document.getElementById('codeDisplay');
const codeNumber = document.getElementById('codeNumber');
const codeTimer = document.getElementById('codeTimer');
const rejectBox = document.getElementById('rejectBox');
const rejectReason = document.getElementById('rejectReason');

let token = null;
let isUploading = false;
let statusPoller = null;
let codeCountdownTimer = null;

// ─── INIT: Get token from URL ──────────────────────────────────────────────────
const url = new URL(window.location.href);
if (url.searchParams.has('token') || url.searchParams.has('t')) {
    token = url.searchParams.get('token') || url.searchParams.get('t');
    requestBtn.disabled = false;
} else {
    statusText.textContent = "No valid token found. Please use the link provided by Ibaddie.";
    statusBox.style.display = 'block';
    requestBtn.style.display = 'none';
}

// ─── ADMIN PRESENCE CHECK (every 10s) ──────────────────────────────────────────
async function checkPresence() {
    try {
        const res = await fetch(`${API_BASE}/api/presence`);
        const data = await res.json();
        if (data.online) {
            presenceBadge.className = 'presence-badge presence-online';
            presenceBadge.style.display = 'inline-flex';
            presenceText.textContent = 'Ibaddie is online ✓';
        } else {
            presenceBadge.className = 'presence-badge presence-offline';
            presenceBadge.style.display = 'inline-flex';
            presenceText.textContent = 'Ibaddie is offline — requests will be queued';
        }
    } catch (e) {
        presenceBadge.style.display = 'none';
    }
}
checkPresence();
setInterval(checkPresence, 10000);

// ─── REQUEST CODE BUTTON ───────────────────────────────────────────────────────
requestBtn.addEventListener('click', () => {
    uploadArea.style.display = 'block';
    requestBtn.style.display = 'none';
    statusBox.style.display = 'none';
    codeDisplay.style.display = 'none';
    rejectBox.style.display = 'none';
});

// ─── FILE UPLOAD ───────────────────────────────────────────────────────────────
uploadArea.addEventListener('click', () => {
    if (!isUploading) fileInput.click();
});

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await handleScreenshotUpload(file);
});

async function handleScreenshotUpload(file) {
    if (isUploading || !token) return;
    isUploading = true;
    uploadArea.style.display = 'none';

    // Show uploading status
    statusBox.style.display = 'block';
    statusText.textContent = 'Compressing and uploading screenshot...';

    try {
        // Compress the image client-side (max 800px, JPEG 70%)
        const compressed = await compressImage(file);
        if (!compressed) throw new Error('Image compression failed');

        // Submit request
        const res = await fetch(`${API_BASE}/api/code-request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, screenshot: compressed })
        });
        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || 'Request failed');
        }

        // Start polling for status
        statusText.textContent = 'Waiting for Ibaddie to review your request...';
        startStatusPolling();
    } catch (e) {
        statusText.textContent = 'Error: ' + e.message;
        requestBtn.style.display = 'block';
        requestBtn.disabled = false;
    } finally {
        isUploading = false;
    }
}

// ─── IMAGE COMPRESSION ─────────────────────────────────────────────────────────
async function compressImage(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const maxW = 800;
                const scale = Math.min(1, maxW / img.width);
                canvas.width = img.width * scale;
                canvas.height = img.height * scale;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', 0.7));
            };
            img.onerror = () => resolve(null);
            img.src = e.target.result;
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
    });
}

// ─── STATUS POLLING (every 3s) ─────────────────────────────────────────────────
function startStatusPolling() {
    if (statusPoller) clearInterval(statusPoller);
    pollStatus(); // immediate first poll
    statusPoller = setInterval(pollStatus, 3000);
}

async function pollStatus() {
    if (!token) return;
    try {
        const res = await fetch(`${API_BASE}/api/code-request/status?token=${token}`);
        const data = await res.json();

        if (data.status === 'none') {
            // No pending request — show request button
            stopStatusPolling();
            statusBox.style.display = 'none';
            requestBtn.style.display = 'block';
            requestBtn.disabled = false;
            codeDisplay.style.display = 'none';
            rejectBox.style.display = 'none';
            return;
        }

        if (data.status === 'pending') {
            statusBox.style.display = 'block';
            statusText.textContent = 'Waiting for Ibaddie to review your request...';
            codeDisplay.style.display = 'none';
            rejectBox.style.display = 'none';
        }

        else if (data.status === 'request_fresh') {
            statusBox.style.display = 'none';
            codeDisplay.style.display = 'none';
            rejectBox.style.display = 'none';
            uploadArea.style.display = 'block';
            // Reset file input so they can select the same file again
            fileInput.value = '';
        }

        else if (data.status === 'approved' && data.code) {
            statusBox.style.display = 'none';
            rejectBox.style.display = 'none';
            codeDisplay.style.display = 'block';
            codeNumber.textContent = data.code;

            // Start countdown
            const expiresIn = data.codeExpiresIn || 30;
            startCodeCountdown(expiresIn);

            // Stop polling (code will expire on its own)
            stopStatusPolling();
        }

        else if (data.status === 'rejected') {
            statusBox.style.display = 'none';
            codeDisplay.style.display = 'none';
            rejectBox.style.display = 'block';
            rejectReason.textContent = data.rejectionReason || 'Please follow the tutorial and try again.';

            // Stop polling — buyer needs to click Request Again
            stopStatusPolling();

            // Show request button again after 3 seconds
            setTimeout(() => {
                rejectBox.style.display = 'none';
                requestBtn.style.display = 'block';
                requestBtn.disabled = false;
            }, 5000);
        }

        else if (data.status === 'expired') {
            stopStatusPolling();
            statusBox.style.display = 'none';
            codeDisplay.style.display = 'none';
            statusText.textContent = 'Code expired. You can request a new one.';
            statusBox.style.display = 'block';
            requestBtn.style.display = 'block';
            requestBtn.disabled = false;
        }
    } catch (e) {
        // Network error — keep polling
    }
}

function stopStatusPolling() {
    if (statusPoller) {
        clearInterval(statusPoller);
        statusPoller = null;
    }
}

// ─── CODE COUNTDOWN ────────────────────────────────────────────────────────────
function startCodeCountdown(expiresIn) {
    if (codeCountdownTimer) clearInterval(codeCountdownTimer);
    let remaining = expiresIn;
    codeTimer.textContent = `Expires in ${remaining}s`;
    codeCountdownTimer = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            clearInterval(codeCountdownTimer);
            codeDisplay.style.display = 'none';
            codeNumber.textContent = '000000';
            statusText.textContent = 'Code expired. You can request a new one.';
            statusBox.style.display = 'block';
            requestBtn.style.display = 'block';
            requestBtn.disabled = false;
            return;
        }
        codeTimer.textContent = `Expires in ${remaining}s`;
    }, 1000);
}

// ─── CHECK FOR EXISTING PENDING REQUEST ON PAGE LOAD ──────────────────────────
async function checkExistingRequest() {
    if (!token) return;
    try {
        const res = await fetch(`${API_BASE}/api/code-request/status?token=${token}`);
        const data = await res.json();
        if (data.status === 'pending') {
            // Has pending request — show waiting status
            requestBtn.style.display = 'none';
            uploadArea.style.display = 'none';
            startStatusPolling();
        } else if (data.status === 'request_fresh') {
            // Admin asked for fresh screenshot
            requestBtn.style.display = 'none';
            uploadArea.style.display = 'block';
            fileInput.value = '';
        } else if (data.status === 'approved' && data.code) {
            // Code was approved while buyer was away
            requestBtn.style.display = 'none';
            uploadArea.style.display = 'none';
            codeDisplay.style.display = 'block';
            codeNumber.textContent = data.code;
            const expiresIn = data.codeExpiresIn || 30;
            if (expiresIn > 0) {
                startCodeCountdown(expiresIn);
            } else {
                // Code already expired
                codeDisplay.style.display = 'none';
                statusText.textContent = 'Code expired. You can request a new one.';
                statusBox.style.display = 'block';
                requestBtn.style.display = 'block';
                requestBtn.disabled = false;
            }
        } else if (data.status === 'rejected') {
            // Was rejected
            requestBtn.style.display = 'none';
            uploadArea.style.display = 'none';
            rejectBox.style.display = 'block';
            rejectReason.textContent = data.rejectionReason || 'Please follow the tutorial and try again.';
            setTimeout(() => {
                rejectBox.style.display = 'none';
                requestBtn.style.display = 'block';
                requestBtn.disabled = false;
            }, 5000);
        }
    } catch (e) {
        // Network error — ignore, buyer can click Request Code
    }
}

// Check for existing request on page load
checkExistingRequest();
