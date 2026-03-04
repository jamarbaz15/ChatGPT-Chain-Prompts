// ── background.js (MV3 service worker) ────────────────────────────────────────
// Owns the chain run: opens one new ChatGPT tab per prompt, waits for the
// content script to finish, downloads the response as a .txt file, then
// closes the tab and opens the next one.
//
// IMPORTANT — MV3 service workers can be killed by Chrome at any time when
// they have no pending Chrome-API events (e.g. after a setTimeout with no
// other activity).  To survive restarts, the chain state is stored in
// chrome.storage.session (cleared when the browser closes, persists across
// SW restarts within the same session).  pendingDownloads stays in memory
// because data-URL downloads complete almost instantly; the gap is too small
// to matter.

// In-memory only: download-id → tab-id
const pendingDownloads = new Map();

// ── Alarm listener ─────────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'promptWatchdog') {
        // A prompt tab has been open for too long without completing.
        // This happens when ChatGPT shows a CAPTCHA, hard rate-limit page, or
        // any other UI the content script cannot handle.  Skip the stuck prompt
        // so the chain can continue.
        getState().then(state => {
            if (state.currentTabId !== null) closeTabAndAdvance(state.currentTabId);
        });
    }
});

// ── Persistent state helpers ───────────────────────────────────────────────────
const DEFAULT_STATE = { prompts: [], currentIndex: 0, currentTabId: null };

function getState() {
    return chrome.storage.session.get('chain')
        .then(r => r.chain ? { ...DEFAULT_STATE, ...r.chain } : { ...DEFAULT_STATE });
}

function setState(updates) {
    return getState().then(current =>
        chrome.storage.session.set({ chain: { ...current, ...updates } })
    );
}

// ── Message routing ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {

        case 'startChain':
            setState({ prompts: request.prompts || [], currentIndex: 0, currentTabId: null })
                .then(() => openNextPrompt());
            break;

        case 'contentReady':
            // Content script fired on page load — if this is our tab, send the prompt
            getState().then(state => {
                if (sender.tab && sender.tab.id === state.currentTabId) {
                    schedulePromptForTab(state.currentTabId);
                }
            });
            break;

        case 'promptDone':
            // Content script finished a response — cancel watchdog, download, advance
            chrome.alarms.clear('promptWatchdog', () => {});
            handlePromptDone(
                sender.tab && sender.tab.id,
                request.text,
                request.promptIndex
            );
            break;

        case 'getProgress':
            // Popup polls this to render the progress bar.
            // Must return true because sendResponse is called asynchronously.
            getState().then(state => {
                sendResponse({ done: state.currentIndex, total: state.prompts.length });
            });
            return true;   // ← keeps the message channel open for async reply

        case 'stopChain':
            // User clicked Stop — clear state then close the active tab
            getState().then(state => {
                const tabToClose = state.currentTabId;
                return setState({ prompts: [], currentIndex: 0, currentTabId: null })
                    .then(() => {
                        if (tabToClose !== null) {
                            chrome.tabs.sendMessage(
                                tabToClose,
                                { action: 'stopExecution' },
                                () => { void chrome.runtime.lastError; }
                            );
                            // Brief pause so the abort message lands before we close
                            setTimeout(() => {
                                chrome.tabs.remove(tabToClose,
                                    () => { void chrome.runtime.lastError; });
                            }, 400);
                        }
                    });
            });
            break;
    }
});

// ── Download tracking ──────────────────────────────────────────────────────────
chrome.downloads.onChanged.addListener(delta => {
    if (!delta.state) return;
    const tabId = pendingDownloads.get(delta.id);
    if (tabId === undefined) return;

    if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
        pendingDownloads.delete(delta.id);
        chrome.downloads.setShelfEnabled(true);   // restore shelf for other downloads
        closeTabAndAdvance(tabId);
    }
});

// ── Core chain logic ───────────────────────────────────────────────────────────
function openNextPrompt() {
    return getState().then(state => {
        if (state.currentIndex >= state.prompts.length) {
            return setState({ currentTabId: null });   // all done
        }
        // Open the next tab and immediately persist its ID so that a SW restart
        // between now and contentReady can still match the tab correctly.
        return new Promise(resolve => {
            chrome.tabs.create({ url: 'https://chatgpt.com/', active: true }, tab => {
                setState({ currentTabId: tab.id }).then(() => {
                    // Watchdog: if this prompt isn't done within 10 minutes, skip it.
                    // Covers CAPTCHA pages, hard rate-limit screens, SW crashes, etc.
                    // resolve() is called INSIDE the create callback so the Promise
                    // only settles after the alarm is guaranteed to be registered.
                    chrome.alarms.clear('promptWatchdog', () => {
                        chrome.alarms.create('promptWatchdog', { delayInMinutes: 10 });
                        resolve();
                    });
                });
            });
        });
    });
}

// Send the current prompt to the content script immediately.
// There is intentionally no setTimeout here: the MV3 service worker can be
// killed by Chrome at any time, and a pending setTimeout is silently dropped
// when that happens.  The content script already has its own 30-second
// inter-prompt pause (in executeTimeout) and calls waitForElement() to wait
// for the ChatGPT textarea, so no SW-side delay is needed.
function schedulePromptForTab(tabId) {
    getState().then(state => {
        const prompt = state.prompts[state.currentIndex];
        if (prompt === undefined) return;
        chrome.tabs.sendMessage(tabId, {
            action: 'executePrompt',
            prompt,
            promptIndex: state.currentIndex + 1,
            total: state.prompts.length
        }, () => { void chrome.runtime.lastError; });
    });
}

function handlePromptDone(tabId, text, promptIndex) {
    const safeText = text || '';
    const filename  = `prompt-${promptIndex}-response.txt`;
    const dataUrl   = 'data:text/plain;charset=utf-8,' + encodeURIComponent(safeText);

    // Hide the download shelf so the file saves silently without covering
    // the screen.  Re-enabled in onChanged once the download settles.
    chrome.downloads.setShelfEnabled(false);

    chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, downloadId => {
        if (chrome.runtime.lastError || downloadId === undefined) {
            chrome.downloads.setShelfEnabled(true);   // restore on failure too
            closeTabAndAdvance(tabId);
            return;
        }
        pendingDownloads.set(downloadId, tabId);
    });
}

function closeTabAndAdvance(tabId) {
    // Persist the incremented index FIRST so a SW restart won't replay the same
    // prompt.  Then close the tab and immediately open the next one.  The
    // 30-second inter-prompt breathing pause lives in the content script (which
    // runs in a stable tab context) rather than here in the service worker,
    // avoiding MV3 SW-lifetime and chrome.alarms minimum-delay edge cases.
    getState()
        .then(state => setState({ currentIndex: state.currentIndex + 1 }))
        .then(() => new Promise(resolve => {
            chrome.tabs.remove(tabId, () => {
                void chrome.runtime.lastError;   // tab may already be closed
                resolve();
            });
        }))
        .then(() => openNextPrompt());
}

// ── Utility ────────────────────────────────────────────────────────────────────
function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
