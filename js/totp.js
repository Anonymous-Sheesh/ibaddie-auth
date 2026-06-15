const secretInput = document.getElementById('secret');
const updatingIn = document.getElementById('updatingIn');
const otpEl = document.getElementById('otp');

if (secretInput) {
    secretInput.value = "Injecting Javascript...";
}

window.onerror = function (msg, url, line) {
    if (secretInput) secretInput.value = "CRASH: " + msg + " (Line " + line + ")";
};

const none = "000000";
let currentOtp = none;
let token = null;
let isWaiting = false; // Track if we're in wait state

// Replace with production URL if hosted separately
const API_BASE = "https://totp-backend.ibaddie.workers.dev";

async function fetchOtp() {
    if (!token) return resetOtp();

    if (secretInput.value !== "Access Token Active...") {
        secretInput.value = "Contacting Backend (" + API_BASE + ")...";
    }

    try {
        const response = await fetch(`${API_BASE}/api/code?token=${token}`);
        const data = await response.json();

        if (!response.ok) {
            secretInput.value = data.error || "Backend rejected request.";
            return resetOtp();
        }

        // Handle wait response when code is expiring soon
        if (data.wait) {
            isWaiting = true;
            secretInput.value = `Showing code in ${data.remainingTime}...`;
            secretInput.style.color = "#ff4c4c"; // Red text for warning
            updatingIn.textContent = data.remainingTime;
            // Start countdown timer
            startCountdown(data.remainingTime);
            // Auto-retry after the remaining time expires
            setTimeout(() => {
                isWaiting = false;
                fetchOtp();
            }, (data.remainingTime + 1) * 1000);
            return;
        }

        secretInput.value = `Access Token Active... (Uses left: ${data.usesLeft})`;
        secretInput.style.color = ""; // Reset color
        setOtp(data.code);
        updatingIn.textContent = data.expiresIn;
    } catch (e) {
        secretInput.value = "Network Blocked - e: " + e.message;
        resetOtp();
    }
}

function setOtp(otp) {
    currentOtp = otp;
    otpEl.value = otp;
    otpEl.style.opacity = '1';
    otpEl.style.cursor = 'pointer';
}

function startCountdown(seconds) {
    let remaining = seconds;
    const countdownInterval = setInterval(() => {
        if (remaining <= 0) {
            clearInterval(countdownInterval);
            return;
        }
        remaining--;
        secretInput.value = `Showing code in ${remaining}...`;
        updatingIn.textContent = remaining;
    }, 1000);
}

function resetOtp() {
    currentOtp = none;
    otpEl.value = none;
    otpEl.style.opacity = '';
    otpEl.style.cursor = '';
}

function timer() {
    if (currentOtp === none) {
        updatingIn.textContent = "30";
        return;
    }

    let current = parseInt(updatingIn.textContent, 10);
    if (isNaN(current) || current <= 1) {
        // Display countdown at 0 while waiting for next code
        updatingIn.textContent = "0";
        // Delay fetch slightly to ensure exact sync with server interval
        setTimeout(fetchOtp, 500);
    } else {
        updatingIn.textContent = (current - 1).toString();
    }
}

async function copyTextToClipboard(text) {
    if (text === none) return;
    try {
        await navigator.clipboard.writeText(text);
        console.log('Copied!');
    } catch {
        fallbackCopyTextToClipboard(text);
    }
}

function fallbackCopyTextToClipboard(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    Object.assign(textArea.style, { top: "0", left: "0", position: "fixed" });
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
        document.execCommand('copy');
        console.log('Fallback: Copying text command was successful');
    } catch (err) {
        console.error('Fallback: Unable to copy', err);
    }

    document.body.removeChild(textArea);
}

setInterval(timer, 1000);

window.addEventListener("visibilitychange", () => {
    // Only fetch on visibility change if we don't have a valid code showing AND not waiting
    // This prevents "code limit reached" when alt-tabbing back during countdown
    if (document.visibilityState === "visible" && currentOtp === none && !isWaiting) {
        fetchOtp();
    }
});

otpEl.addEventListener('click', () => copyTextToClipboard(currentOtp));

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

const url = new URL(window.location.href);
if (url.searchParams.has('token') || url.searchParams.has('t')) {
    token = url.searchParams.get('token') || url.searchParams.get('t');

    secretInput.value = "Token Found, booting up...";
    setTimeout(() => {
        fetchOtp();
    }, 50);
} else {
    secretInput.value = "No valid access token found in url.";
}
