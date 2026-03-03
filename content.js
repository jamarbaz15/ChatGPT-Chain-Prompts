// ── content.js ────────────────────────────────────────────────────────────────
// Runs on every https://chatgpt.com/* page.
// Signals the background service worker that we are ready, then waits for an
// 'executePrompt' message.  When received it:
//   1. Types a few words then pastes the rest of the prompt (human-like + safe)
//   2. Submits it
//   3. Waits for ChatGPT to finish (with random scroll / mouse jitter)
//   4. Extracts the last assistant message
//   5. Tells background 'promptDone' so it can download + advance the chain

// Let background know this tab's content script is alive
chrome.runtime.sendMessage({ action: 'contentReady' }, () => {
    void chrome.runtime.lastError;
});

// ── Utilities ─────────────────────────────────────────────────────────────────
const sleep       = ms          => new Promise(r => setTimeout(r, ms));
const randomInt   = (min, max)  => Math.floor(Math.random() * (max - min + 1)) + min;
const randomDelay = (min, max)  => sleep(randomInt(min, max));

// Set to true by 'stopExecution' message; checked at every await checkpoint
let stopped = false;

// Dispatch a synthetic mousemove at a random position to look more human
function jiggleMouse() {
    document.dispatchEvent(new MouseEvent('mousemove', {
        clientX: randomInt(60, window.innerWidth  - 60),
        clientY: randomInt(60, window.innerHeight - 60),
        bubbles: true
    }));
}

// ── Human-like typing ─────────────────────────────────────────────────────────
// Strategy: type the first 3-8 words one character at a time, then paste the
// remaining text in one go.
//
// Why paste the rest? Typing \n character-by-character via execCommand triggers
// ChatGPT's "Enter = submit" handler and sends before the prompt is complete.
// A bulk execCommand('insertText') is indistinguishable from Ctrl+V and safely
// inserts newlines as line-breaks rather than submissions.
async function humanType(element, text) {
    element.focus();
    await randomDelay(600, 1800);
    if (stopped) return;

    // Clear the field
    element.textContent = '';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(randomInt(80, 200));
    if (stopped) return;

    // Find the cutoff: stop typing after N words OR at the first newline
    const maxTypeWords = randomInt(3, 8);
    let cutoff = text.length;
    let wordCount = 0;

    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') {
            cutoff = i;   // never type a bare \n; paste the rest
            break;
        }
        // Count a word boundary (transition from non-space to space)
        if (text[i] === ' ' && i > 0 && text[i - 1] !== ' ') {
            wordCount++;
            if (wordCount >= maxTypeWords) {
                cutoff = i;   // stop here; paste the rest
                break;
            }
        }
    }

    const typed  = text.slice(0, cutoff);
    const pasted = text.slice(cutoff);

    // Type first portion character by character
    for (const char of typed) {
        if (stopped) return;
        document.execCommand('insertText', false, char);
        const delay = Math.random() < 0.05
            ? randomInt(450, 1100)  // occasional thinking pause
            : randomInt(48, 145);   // normal keystroke cadence
        await sleep(delay);
        if (Math.random() < 0.08) jiggleMouse();
    }

    // Paste the rest in one operation (safe for newlines, fast for long prompts)
    if (pasted) {
        if (stopped) return;
        await randomDelay(200, 600);  // brief pause like reaching for Ctrl+V
        if (stopped) return;
        document.execCommand('insertText', false, pasted);
        await sleep(randomInt(150, 400));
    }

    if (stopped) return;
    // Post-entry review pause before clicking send
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
function waitForElement(selector, timeoutMs = 15000) {
    return new Promise(resolve => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        let elapsed = 0;
        const id = setInterval(() => {
            if (stopped) { clearInterval(id); resolve(null); return; }
            const el = document.querySelector(selector);
            if (el) { clearInterval(id); resolve(el); return; }
            elapsed += 200;
            if (elapsed >= timeoutMs) { clearInterval(id); resolve(null); }
        }, 200);
    });
}

// Clicks the send button, retrying every 100 ms for up to 5 s
async function clickSendButton() {
    for (let i = 0; i < 50; i++) {
        if (stopped) return false;
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
    stopped = false;

    // 1. Wait for ChatGPT's React UI to render the textarea (up to 15 s)
    const textarea = await waitForElement('#prompt-textarea', 15000);
    if (!textarea || stopped) return;

    // 2. Type first few words, paste the rest
    await humanType(textarea, prompt);
    if (stopped) return;

    // 3. Click send
    const sent = await clickSendButton();
    if (!sent || stopped) return;

    // 4. Phase 1 – wait for ChatGPT to START generating (stop button appears)
    const started = await new Promise(resolve => {
        let elapsed = 0;
        const interval = randomInt(400, 650);
        const id = setInterval(() => {
            if (stopped)       { clearInterval(id); resolve(false); return; }
            if (isGenerating()) { clearInterval(id); resolve(true);  return; }
            elapsed += interval;
            if (elapsed >= 30000) { clearInterval(id); resolve(false); }
        }, interval);
    });
    if (!started || stopped) return;

    // 5. Phase 2 – wait for generation to FINISH, simulating reading behaviour
    await new Promise(resolve => {
        const scrollTimer = setInterval(() => {
            if (Math.random() < 0.35) {
                window.scrollBy({ top: randomInt(80, 320), behavior: 'smooth' });
                jiggleMouse();
            }
        }, randomInt(2500, 5000));

        const pollInterval = randomInt(800, 1300);
        const doneTimer = setInterval(() => {
            if (stopped || isResponseComplete()) {
                clearInterval(doneTimer);
                clearInterval(scrollTimer);
                resolve();
            }
        }, pollInterval);
    });
    if (stopped) return;

    // 6. Extract response and tell background to download + advance the chain
    const responseText = extractLastResponse();
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
    if (request.action === 'stopExecution') {
        stopped = true;
    }
});
