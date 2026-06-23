// ══════════════════════════════════════════════════════════════════════════════
// totp.js — V2.0 HARDENED FRONTEND
// ══════════════════════════════════════════════════════════════════════════════
// Changes from V1:
//   • Customer no longer auto-receives a code on page load.
//     They see a "Request Code" button. Click → HWID computed → POST /api/code/request
//   • Code hides on tab blur (visibilitychange) — kills "paste into MS security tab" attack
//   • 24h cooldown shown as live countdown
//   • Lockout state shown with reason + retry time
//   • HWID reset button if device changed
// ══════════════════════════════════════════════════════════════════════════════

const secretInput = document.getElementById('secret');
const updatingIn = document.getElementById('updatingIn');
const otpEl = document.getElementById('otp');
const requestBtn = document.getElementById('requestBtn');
const cooldownEl = document.getElementById('cooldown');
const lockoutEl = document.getElementById('lockout');

if (secretInput) secretInput.value = "Booting up...";

window.onerror = function (msg, url, line) {
    if (secretInput) secretInput.value = "CRASH: " + msg + " (Line " + line + ")";
};

const none = "000000";
let currentOtp = none;
let token = null;
let codeExpiryTimer = null;
let cooldownTimer = null;
let lastCode = null;
let lastCodeExpireAt = 0;
let isLocked = false;

const API_BASE = "https://totp-backend.ibaddie.workers.dev";

// ─── HWID COMPUTATION ──────────────────────────────────────────────────────────

function computeCanvasHash() {
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 240; canvas.height = 60;
        const ctx = canvas.getContext('2d');
        ctx.textBaseline = 'top';
        ctx.font = '14px Arial';
        ctx.fillStyle = '#f60';
        ctx.fillRect(125, 1, 62, 20);
        ctx.fillStyle = '#069';
        ctx.fillText('Ibaddie HWID ☺', 2, 15);
        ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
        ctx.fillText('Ibaddie HWID ☺', 4, 17);
        const dataUrl = canvas.toDataURL();
        return hashString(dataUrl);
    } catch (e) { return 'no-canvas'; }
}

function computeWebglHash() {
    try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl) return 'no-webgl';
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        const vendor = debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
        const renderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        return hashString(`${vendor}|${renderer}|${gl.getParameter(gl.MAX_TEXTURE_SIZE)}|${gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)}`);
    } catch (e) { return 'no-webgl'; }
}

async function computeAudioHash() {
    try {
        const AudioCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!AudioCtx) return 'no-audio';
        const ctx = new AudioCtx(1, 44100, 44100);
        const oscillator = ctx.createOscillator();
        oscillator.type = 'triangle';
        oscillator.frequency.value = 1000;
        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -50;
        compressor.knee.value = 40;
        compressor.ratio.value = 12;
        compressor.attack.value = 0;
        compressor.release.value = 0.25;
        oscillator.connect(compressor);
        compressor.connect(ctx.destination);
        oscillator.start(0);
        const buffer = await ctx.startRendering();
        const samples = buffer.getChannelData(0);
        let sum = 0;
        for (let i = 4500; i < 5000; i++) sum += Math.abs(samples[i]);
        return hashString(sum.toString());
    } catch (e) { return 'no-audio'; }
}

function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const chr = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0;
    }
    return 'h' + (hash >>> 0).toString(16);
}

async function computeHwid() {
    const canvas = computeCanvasHash();
    const webgl = computeWebglHash();
    const audio = await computeAudioHash();
    const screen = `${window.screen.width}x${window.screen.height}x${window.screen.colorDepth}x${window.devicePixelRatio}`;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const ua = navigator.userAgent;
    return { canvas, webgl, audio, screen, tz, ua };
}

// ─── CODE DISPLAY ──────────────────────────────────────────────────────────────

function setOtp(otp) {
    currentOtp = otp;
    lastCode = otp;
    if (otpEl) {
        otpEl.value = otp;
        otpEl.style.opacity = '1';
        otpEl.style.cursor = 'pointer';
    }
}

function resetOtp() {
    currentOtp = none;
    if (otpEl) {
        otpEl.value = none;
        otpEl.style.opacity = '';
        otpEl.style.cursor = '';
    }
}

function hideCode() {
    // Tab-blur hiding removed — only 1 code per 24h, no need to hide.
    // Function kept as no-op for backward compat (event listeners removed below).
}

// ─── TIMER ─────────────────────────────────────────────────────────────────────

function startExpiryCountdown(expiresIn) {
    if (codeExpiryTimer) clearInterval(codeExpiryTimer);
    let remaining = expiresIn;
    if (updatingIn) updatingIn.textContent = String(remaining);
    codeExpiryTimer = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            clearInterval(codeExpiryTimer);
            resetOtp();
            if (secretInput) {
                secretInput.value = "Code expired. Click Request Code again (24h cooldown applies).";
                secretInput.style.color = "";
            }
            if (updatingIn) updatingIn.textContent = "0";
            return;
        }
        if (updatingIn) updatingIn.textContent = String(remaining);
    }, 1000);
}

function startCooldownCountdown(retryInSeconds) {
    if (cooldownTimer) clearInterval(cooldownTimer);
    if (cooldownEl) cooldownEl.style.display = 'block';
    if (requestBtn) requestBtn.disabled = true;
    let remaining = retryInSeconds;
    const update = () => {
        const h = Math.floor(remaining / 3600);
        const m = Math.floor((remaining % 3600) / 60);
        const s = remaining % 60;
        if (cooldownEl) {
            cooldownEl.textContent = `Next code available in ${h}h ${m.toString().padStart(2, '0')}m ${s.toString().padStart(2, '0')}s`;
        }
        if (remaining <= 0) {
            clearInterval(cooldownTimer);
            if (cooldownEl) cooldownEl.style.display = 'none';
            if (requestBtn) requestBtn.disabled = false;
            if (secretInput) secretInput.value = "Ready — click Request Code";
        }
        remaining--;
    };
    update();
    cooldownTimer = setInterval(update, 1000);
}

function showLockout(reason, retryInSeconds) {
    isLocked = true;
    if (lockoutEl) {
        lockoutEl.style.display = 'block';
        const h = Math.floor(retryInSeconds / 3600);
        const m = Math.floor((retryInSeconds % 3600) / 60);
        lockoutEl.innerHTML = `
            <strong>🔒 IP address locked for 24 hours</strong>
            <div style="margin-top: 8px; font-size: 0.85rem; line-height: 1.55;">
                ${reason || 'Daily code limit reached.'}<br><br>
                <em>This is for security precautions. You should only need a code once or twice to log in to the launcher — any more is a risk to the account. If this is an issue, purchase full access via custom order by messaging Ibaddie. You can ask for codes after 24h again.</em>
            </div>
            <div style="margin-top: 10px; font-size: 0.8rem; color: #ffaaaa;">
                ⏳ Retry in <strong style="color: #ff4c4c;">${h}h ${m}m</strong>
            </div>
        `;
    }
    if (requestBtn) requestBtn.disabled = true;
    // Don't show the HWID reset button anymore — there's no HWID binding to reset.
    // Customer must wait 24h or contact Ibaddie to reset uses.
}

// ─── REQUEST CODE FLOW ─────────────────────────────────────────────────────────

// Admin mode: triggered by ?admin=1 URL param. When set, frontend sends admin:true
// flag with the request. Worker checks HWID against ADMIN_HWIDS allowlist. If match,
// returns a code WITHOUT touching the buyer's quota/cooldown.
const urlParams = new URL(window.location.href);
const ADMIN_MODE = urlParams.searchParams.has('admin') || urlParams.searchParams.has('a');
const DISCOVER_MODE = urlParams.searchParams.has('discoverAdmin') || urlParams.searchParams.has('discover');

async function requestCode() {
    if (!token || isLocked) return;
    if (secretInput) {
        secretInput.value = "Computing device fingerprint...";
        secretInput.style.color = "";
    }
    if (requestBtn) requestBtn.disabled = true;

    const hwid = await computeHwid();

    try {
        if (secretInput) secretInput.value = ADMIN_MODE ? "Requesting code (admin mode)..." : "Requesting code from server...";
        const response = await fetch(`${API_BASE}/api/code/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ADMIN_MODE ? { token, hwid, admin: true } : { token, hwid })
        });
        const data = await response.json();

        if (!response.ok) {
            if (data.admin && data.unauthorized) {
                if (secretInput) {
                    secretInput.value = "Admin access denied — this device is not registered. Open with ?discoverAdmin=1 to see your HWID hash.";
                    secretInput.style.color = "#ff4c4c";
                }
                if (requestBtn) requestBtn.disabled = false;
                return;
            }
            if (data.locked) {
                const retryIn = data.retryInSeconds || Math.ceil(((data.lockoutUntil || 0) - Date.now()) / 1000);
                showLockout(data.lockoutReason || data.error, retryIn);
                if (secretInput) secretInput.value = "IP address locked for 24h.";
                return;
            }
            if (secretInput) {
                secretInput.value = data.error || "Request rejected.";
                secretInput.style.color = "#ff4c4c";
            }
            if (requestBtn) requestBtn.disabled = false;
            return;
        }

        // Success — but wait for a fresh 30s window before showing the code.
        // If the server returns a code with <25s left, we wait until the next
        // 30s window starts so the customer always gets a full 25-30s to use the code.
        const minWindowForFreshCode = 25;  // require at least 25s
        if (data.expiresIn < minWindowForFreshCode && !data.admin) {
            const waitSeconds = data.expiresIn + 2;  // +2 to safely land on the new window
            // Stop any existing expiry countdown timer
            if (codeExpiryTimer) { clearInterval(codeExpiryTimer); codeExpiryTimer = null; }
            // Set the "expires in" display to NA — only the "Showing code in..." text should show
            if (updatingIn) updatingIn.textContent = "NA";
            // Reset any visible code
            resetOtp();
            // Show the "Showing code in X..." message in red
            if (secretInput) {
                secretInput.value = `Showing code in ${waitSeconds}...`;
                secretInput.style.color = "#ff4c4c";
            }
            // Live countdown "Showing code in X..."
            // IMPORTANT: Keep #updatingIn at "NA" the entire time — do NOT let it count down.
            // Only the secretInput (red text) counts down.
            let countdown = waitSeconds;
            const waitTimer = setInterval(() => {
                countdown--;
                if (countdown <= 0) {
                    clearInterval(waitTimer);
                    return;
                }
                if (secretInput) secretInput.value = `Showing code in ${countdown}...`;
                // Force #updatingIn to stay at "NA" — the expires-in timer is NOT running
                if (updatingIn) updatingIn.textContent = "NA";
            }, 1000);

            // Wait for the next window, then request the fresh code
            await new Promise(r => setTimeout(r, waitSeconds * 1000));
            clearInterval(waitTimer);

            // Re-request the code — server will return the new 30s window's code.
            // The device count was already incremented on the first request, so this
            // re-fetch doesn't consume another allowance (anti-replay logic in worker).
            try {
                const freshResponse = await fetch(`${API_BASE}/api/code/request`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, hwid })
                });
                const freshData = await freshResponse.json();
                if (freshResponse.ok && freshData.code) {
                    // Use the fresh code — worker returns expiresIn: 30 for fresh codes
                    data.code = freshData.code;
                    data.expiresIn = freshData.expiresIn;
                }
                // If fresh fetch failed, use the original code (it's still valid for whatever time remains)
            } catch (e) {
                // Network error on re-fetch — fall back to original code
            }
        }

        // Success — show code
        if (secretInput) {
            if (data.admin) {
                secretInput.value = "ADMIN ACCESS — buyer's quota & cooldown untouched";
                secretInput.style.color = "#FFD700";
            } else if (data.codesRemainingToday !== undefined) {
                const remaining = data.codesRemainingToday;
                const limit = data.dailyLimit || 1;
                if (remaining === 0) {
                    secretInput.value = `Code shown — daily limit reached (${limit}/${limit}). Next request will lock this device for 24h.`;
                    secretInput.style.color = "#FFD700";
                } else {
                    secretInput.value = `Access Token Active... (${remaining} code${remaining === 1 ? '' : 's'} left today)`;
                    secretInput.style.color = "";
                }
            } else {
                secretInput.value = "Access Token Active...";
                secretInput.style.color = "";
            }
        }
        setOtp(data.code);
        startExpiryCountdown(data.expiresIn);

        // After code expires, re-enable the Request button (no global cooldown anymore —
        // the per-device count is tracked server-side)
        setTimeout(() => {
            if (requestBtn) requestBtn.disabled = false;
            resetOtp();
            if (secretInput) {
                if (data.admin) {
                    secretInput.value = "Admin code expired. Click Request Code again.";
                } else if (data.codesRemainingToday === 0) {
                    secretInput.value = "Daily limit reached — next request will lock this device for 24h.";
                } else {
                    secretInput.value = "Code expired. Click Request Code again.";
                }
                secretInput.style.color = "";
            }
        }, data.expiresIn * 1000 + 500);
    } catch (e) {
        if (secretInput) {
            secretInput.value = "Network error: " + e.message;
            secretInput.style.color = "#ff4c4c";
        }
        if (requestBtn) requestBtn.disabled = false;
    }
}

// ─── DISCOVER MODE: shows the admin their HWID hash for registration ──────────

async function showDiscoverMode() {
    if (secretInput) {
        secretInput.value = "Computing your device fingerprint...";
        secretInput.style.color = "#FFD700";
    }
    if (requestBtn) requestBtn.style.display = 'none';

    const hwid = await computeHwid();
    // Mirror the worker's hashHwid function locally so the displayed hash matches
    const parts = [hwid.canvas || '', hwid.webgl || '', hwid.audio || '', hwid.screen || '', hwid.tz || '', hwid.ua || ''];
    const data = new TextEncoder().encode(parts.join('|'));
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

    // Inject a discovery panel into the page
    const container = document.querySelector('.container');
    if (container) {
        const panel = document.createElement('div');
        panel.className = 'discover-panel';
        panel.innerHTML = `
            <span class="discover-panel-title">🔑 Your Admin Device HWID</span>
            <div class="discover-panel-hash">${hashHex}</div>
            <button class="discover-panel-btn" onclick="navigator.clipboard.writeText('${hashHex}').then(() => alert('HWID copied to clipboard!'))">
                Copy HWID to Clipboard
            </button>
            <p class="discover-panel-help">
                Add this hash to the <code>ADMIN_HWIDS</code>
                env var in your Cloudflare Worker settings (comma-separated if you have multiple devices).
                Then visit any customer link with <code>?admin=1</code>
                appended to access it without affecting the buyer's quota or cooldown.
            </p>
        `;
        container.appendChild(panel);
    }
    if (secretInput) secretInput.value = "Discovery mode — see panel below";
}

function CONFIG_COOLDOWN_SECONDS() {
    return 24 * 60 * 60; // 24h — must match worker.js
}

// ─── HWID RESET (REMOVED) ────────────────────────────────────────────────────
// No more HWID binding — customers don't need a device reset button anymore.
// Per-device 1-code-per-24h limit replaces the old HWID binding model.

// ─── CLIPBOARD ─────────────────────────────────────────────────────────────────

async function copyTextToClipboard(text) {
    if (text === none) return;
    try { await navigator.clipboard.writeText(text); }
    catch { fallbackCopyTextToClipboard(text); }
}

function fallbackCopyTextToClipboard(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    Object.assign(textArea.style, { top: "0", left: "0", position: "fixed" });
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try { document.execCommand('copy'); } catch (err) { console.error('Copy failed', err); }
    document.body.removeChild(textArea);
}

// ─── EVENT WIRING ──────────────────────────────────────────────────────────────

// Tab-blur listeners removed — only 1 code per 24h, no need to hide on tab switch.
// Code stays visible until it expires (30s window).

if (otpEl) otpEl.addEventListener('click', () => copyTextToClipboard(currentOtp));
if (requestBtn) requestBtn.addEventListener('click', requestCode);

if (typeof tippy === 'function') {
    tippy('#otp', {
        content: "Copied!",
        trigger: 'click',
        animation: 'shift-away',
        hideOnClick: false,
        theme: 'translucent',
        offset: [0, -27.5],
        onShow(instance) {
            if (currentOtp === none) return false;
            setTimeout(() => instance.hide(), 500);
        }
    });
}

// ─── INIT ──────────────────────────────────────────────────────────────────────

const url = new URL(window.location.href);
if (DISCOVER_MODE) {
    // ?discoverAdmin=1 — show the admin their HWID hash for registration
    if (secretInput) secretInput.value = "Discovery mode active";
    showDiscoverMode();
} else if (url.searchParams.has('token') || url.searchParams.has('t')) {
    token = url.searchParams.get('token') || url.searchParams.get('t');
    if (secretInput) {
        secretInput.value = ADMIN_MODE
            ? "ADMIN MODE — your access won't affect the buyer. Click Request Code."
            : "Token active. Click Request Code to continue.";
        if (ADMIN_MODE) secretInput.style.color = "#FFD700";
    }
    if (requestBtn) {
        requestBtn.disabled = false;
        if (ADMIN_MODE) {
            requestBtn.textContent = "Request Code (Admin)";
        }
    }
} else {
    if (secretInput) secretInput.value = "No valid access token found in url.";
    if (requestBtn) requestBtn.disabled = true;
}
