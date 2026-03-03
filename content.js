// ── content.js ────────────────────────────────────────────────────────────────
// Runs on every https://chatgpt.com/* page.
// Signals the background service worker that we are ready, then waits for an
// 'executePrompt' message.  When received it:
//   1. Types the prompt character-by-character with human-like timing
//   2. Submits it
//   3. Waits for ChatGPT to finish (with random scroll / mouse jitter)
//   4. Extracts the last assistant message
//   5. Tells background 'promptDone' so it can download + advance the chain

// Let background know this tab's content script is alive
chrome.runtime.sendMessage({ action: 'contentReady' }, () => {
    // Suppress "no listener" errors that appear if background isn't running yet
    void chrome.runtime.lastError;
});

// ── Utilities ─────────────────────────────────────────────────────────────────
const sleep       = ms          => new Promise(r => setTimeout(r, ms));
const randomInt   = (min, max)  => Math.floor(Math.random() * (max - min + 1)) + min;
const randomDelay = (min, max)  => sleep(randomInt(min, max));

// Dispatch a synthetic mousemove at a random position to look more human
function jiggleMouse() {
    document.dispatchEvent(new MouseEvent('mousemove', {
        clientX: randomInt(60, window.innerWidth  - 60),
        clientY: randomInt(60, window.innerHeight - 60),
        bubbles: true
    }));
}

// ── Human-like typing ─────────────────────────────────────────────────────────
// Types into a contenteditable element one character at a time.
// Uses document.execCommand('insertText') which produces real InputEvents
// indistinguishable from keyboard input at the DOM level.
async function humanType(element, text) {
    element.focus();

    // Pre-typing pause: user "reads" the prompt before starting to type
    await randomDelay(600, 1800);

    // Clear whatever is already in the field
    element.textContent = '';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(randomInt(80, 200));

    for (const char of text) {
        document.execCommand('insertText', false, char);

        // Occasional longer "thinking" pause (≈5% of keystrokes)
        const delay = Math.random() < 0.05
            ? randomInt(450, 1100)   // brief pause mid-thought
            : randomInt(48, 145);    // normal keystroke cadence
        await sleep(delay);

        // Rare mouse jiggle during typing (≈8% of keystrokes)
        if (Math.random() < 0.08) jiggleMouse();
    }

    // Post-typing pause: user "reviews" what they wrote before sending
    await randomDelay(700, 2200);
}

// ── ChatGPT DOM helpers ────────────────────────────────────────────────────────
const isGenerating = () =>
    document.querySelector('button[aria-label="Stop streaming"]') !== null ||
    document.querySelector('button[data-testid="stop-button"]')   !== null;

const isResponseComplete = () =>
    document.querySelector('button[data-state="closed"]') !== null;

function extractLastResponse() {
    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (!msgs.length) return '';
    const last = msgs[msgs.length - 1];
    return (last.innerText || last.textContent || '').trim();
}

// ── Polling helpers ────────────────────────────────────────────────────────────
// Resolves with the element once it appears, or null after timeoutMs
function waitForElement(selector, timeoutMs = 15000) {
    return new Promise(resolve => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        let elapsed = 0;
        const id = setInterval(() => {
            const el = document.querySelector(selector);
            if (el) { clearInterval(id); resolve(el); return; }
            elapsed += 200;
            if (elapsed >= timeoutMs) { clearInterval(id); resolve(null); }
        }, 200);
    });
}

// Resolves true when condFn() returns truthy, false on timeout
function waitForCondition(condFn, timeoutMs, intervalMs = 500) {
    return new Promise(resolve => {
        if (condFn()) return resolve(true);
        let elapsed = 0;
        const id = setInterval(() => {
            if (condFn()) { clearInterval(id); resolve(true); return; }
            elapsed += intervalMs;
            if (elapsed >= timeoutMs) { clearInterval(id); resolve(false); }
        }, intervalMs);
    });
}

// Clicks the send button, retrying every 100 ms for up to 5 s
async function clickSendButton() {
    for (let i = 0; i < 50; i++) {
        const btn = document.querySelector(
            'button[aria-label="Send prompt"][data-testid="send-button"]'
        );
        if (btn) { btn.click(); return true; }
        await sleep(100);
    }
    return false;
}

// ── Main execution flow ────────────────────────────────────────────────────────
async function executePrompt(prompt, promptIndex, total) {
    // 1. Wait for ChatGPT's React UI to render the textarea (up to 15 s)
    const textarea = await waitForElement('#prompt-textarea', 15000);
    if (!textarea) return; // page didn't load in time

    // 2. Type the prompt with human-like character delays + jitter
    await humanType(textarea, prompt);

    // 3. Click the send button (human review delay already in humanType)
    const sent = await clickSendButton();
    if (!sent) return;

    // 4. Phase 1 – wait for ChatGPT to START generating (stop button appears)
    //    Give up after 30 s with jitter on the polling interval
    const started = await waitForCondition(isGenerating, 30000, randomInt(400, 650));
    if (!started) return;

    // 5. Phase 2 – wait for generation to FINISH, simulating reading behaviour
    await new Promise(resolve => {
        // Randomly scroll down every few seconds as if the user is reading
        const scrollTimer = setInterval(() => {
            if (Math.random() < 0.35) {
                window.scrollBy({ top: randomInt(80, 320), behavior: 'smooth' });
                jiggleMouse();
            }
        }, randomInt(2500, 5000));

        // Poll for completion with jittered interval so timing isn't perfectly regular
        const pollInterval = randomInt(800, 1300);
        const doneTimer = setInterval(() => {
            if (isResponseComplete()) {
                clearInterval(doneTimer);
                clearInterval(scrollTimer);
                resolve();
            }
        }, pollInterval);
    });

    // 6. Extract the last assistant response from the DOM
    const responseText = extractLastResponse();

    // 7. Tell background — it will download the .txt and advance the chain
    chrome.runtime.sendMessage({
        action: 'promptDone',
        text: responseText,
        promptIndex
    }, () => { void chrome.runtime.lastError; });
}

// ── Message listener ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(request => {
    if (request.action === 'executePrompt') {
        executePrompt(request.prompt, request.promptIndex, request.total);
    }
});
