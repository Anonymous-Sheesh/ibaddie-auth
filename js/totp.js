const secretInput = document.getElementById('secret');
const updatingIn = document.getElementById('updatingIn');
const otpEl = document.getElementById('otp');
const requestBtn = document.getElementById('requestBtn');
const cooldownEl = document.getElementById('cooldown');
const lockoutEl = document.getElementById('lockout');
const resetHwidBtn = document.getElementById('resetHwidBtn');

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
    if (currentOtp !== none) {
        resetOtp();
        if (secretInput) {
            secretInput.value = "Code hidden — tab lost focus. Click Request Code again.";
            secretInput.style.color = "#ff4c4c";
        }
    }
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
        lockoutEl.innerHTML = `<strong>Account locked.</strong> ${reason || 'Suspicious activity detected.'}<br>` +
            `Retry in ${h}h ${m}m. Contact Ibaddie if you believe this is an error.`;
    }
    if (requestBtn) requestBtn.disabled = true;
    if (resetHwidBtn) resetHwidBtn.style.display = 'inline-block';
}

// ─── REQUEST CODE FLOW ─────────────────────────────────────────────────────────

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
                if (secretInput) secretInput.value = "Account locked.";
                return;
            }
            if (secretInput) {
                secretInput.value = data.error || "Request rejected.";
                secretInput.style.color = "#ff4c4c";
            }
            if (requestBtn) requestBtn.disabled = false;
            return;
        }

        if (data.cooldown) {
            startCooldownCountdown(data.retryInSeconds);
            if (secretInput) {
                secretInput.value = "Cooldown active — see timer below.";
                secretInput.style.color = "";
            }
            return;
        }

        if (secretInput) {
            if (data.admin) {
                secretInput.value = "ADMIN ACCESS — buyer's quota & cooldown untouched";
                secretInput.style.color = "#FFD700";
            } else {
                secretInput.value = "Access Token Active...";
                secretInput.style.color = "";
            }
        }
        setOtp(data.code);
        startExpiryCountdown(data.expiresIn);

        if (!data.admin) {
            setTimeout(() => {
                startCooldownCountdown(Math.floor(CONFIG_COOLDOWN_SECONDS()));
            }, data.expiresIn * 1000 + 500);
        } else {
            setTimeout(() => {
                if (requestBtn) requestBtn.disabled = false;
                resetOtp();
                if (secretInput) {
                    secretInput.value = "Admin code expired. Click Request Code again.";
                    secretInput.style.color = "";
                }
            }, data.expiresIn * 1000 + 500);
        }
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
    const parts = [hwid.canvas || '', hwid.webgl || '', hwid.audio || '', hwid.screen || '', hwid.tz || '', hwid.ua || ''];
    const data = new TextEncoder().encode(parts.join('|'));
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

    const container = document.querySelector('.container');
    if (container) {
        const panel = document.createElement('div');
        panel.style.cssText = 'background: rgba(255, 215, 0, 0.1); border: 1px solid rgba(255, 215, 0, 0.5); border-radius: 10px; padding: 16px; margin: 16px 0; font-family: monospace; word-break: break-all; color: #FFD700;';
        panel.innerHTML = `
            <strong style="display:block; margin-bottom: 8px;">🔑 Your Admin Device HWID</strong>
            <div style="background: rgba(0,0,0,0.5); padding: 10px; border-radius: 6px; margin: 8px 0; font-size: 0.85rem;">${hashHex}</div>
            <button onclick="navigator.clipboard.writeText('${hashHex}').then(() => alert('HWID copied to clipboard!'))"
                style="background: linear-gradient(135deg, #FFD700, #FFA500); color: black; border: none; padding: 10px 16px; border-radius: 8px; cursor: pointer; font-weight: bold; margin-top: 8px;">
                Copy HWID to Clipboard
            </button>
            <p style="margin-top: 12px; font-size: 0.8rem; color: #aaa; font-family: inherit;">
                Add this hash to the <code style="background: rgba(0,0,0,0.5); padding: 2px 6px; border-radius: 4px;">ADMIN_HWIDS</code>
                env var in your Cloudflare Worker settings (comma-separated if you have multiple devices).
                Then visit any customer link with <code style="background: rgba(0,0,0,0.5); padding: 2px 6px; border-radius: 4px;">?admin=1</code>
                appended to access it without affecting the buyer's quota or cooldown.
            </p>
        `;
        container.appendChild(panel);
    }
    if (secretInput) secretInput.value = "Discovery mode — see panel below";
}

function CONFIG_COOLDOWN_SECONDS() {
    return 24 * 60 * 60;
}

// ─── HWID RESET ────────────────────────────────────────────────────────────────

async function requestHwidReset() {
    if (!token) return;
    if (!confirm("Request a device reset? This is allowed once every 7 days. You'll need to click Request Code again after.")) return;
    try {
        const res = await fetch(`${API_BASE}/api/admin/reset-hwid`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        const data = await res.json();
        if (res.ok) {
            alert("Device reset approved. Click Request Code again.");
            isLocked = false;
            if (lockoutEl) lockoutEl.style.display = 'none';
            if (requestBtn) requestBtn.disabled = false;
            if (resetHwidBtn) resetHwidBtn.style.display = 'none';
        } else {
            alert("Reset denied: " + (data.error || 'unknown reason'));
        }
    } catch (e) {
        alert("Network error: " + e.message);
    }
}

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

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hideCode();
});
window.addEventListener('blur', hideCode);

if (otpEl) otpEl.addEventListener('click', () => copyTextToClipboard(currentOtp));
if (requestBtn) requestBtn.addEventListener('click', requestCode);
if (resetHwidBtn) resetHwidBtn.addEventListener('click', requestHwidReset);

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
