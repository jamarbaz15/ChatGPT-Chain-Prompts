// ── background.js (MV3 service worker) ────────────────────────────────────────
// Owns the chain run: opens one new ChatGPT tab per prompt, waits for the
// content script to finish, downloads the response as a .txt file, then
// closes the tab and opens the next one.

const state = {
    prompts: [],          // pre-parsed array of prompt strings
    currentIndex: 0,      // which prompt we are on
    currentTabId: null,   // the tab we just created
    // Map<downloadId, tabId> — let us close the right tab once the download finishes
    pendingDownloads: new Map()
};

// ── Message routing ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender) => {
    switch (request.action) {

        case 'startChain':
            // Called by popup when the user clicks "Use Prompt Chain"
            state.prompts = request.prompts || [];
            state.currentIndex = 0;
            state.pendingDownloads.clear();
            openNextPrompt();
            break;

        case 'contentReady':
            // Content script fired on page load — if this is our tab, send the prompt
            if (sender.tab && sender.tab.id === state.currentTabId) {
                schedulePromptForTab(state.currentTabId);
            }
            break;

        case 'promptDone':
            // Content script finished a response — download it, then advance
            handlePromptDone(
                sender.tab && sender.tab.id,
                request.text,
                request.promptIndex
            );
            break;

        case 'stopChain':
            // User clicked Stop — abort immediately
            state.prompts = [];
            state.currentIndex = 0;
            state.pendingDownloads.clear();
            if (state.currentTabId !== null) {
                // Tell the content script to abort whatever it's doing
                chrome.tabs.sendMessage(
                    state.currentTabId,
                    { action: 'stopExecution' },
                    () => { void chrome.runtime.lastError; }
                );
                // Close the tab after a brief moment so the abort message lands
                const tabToClose = state.currentTabId;
                state.currentTabId = null;
                setTimeout(() => {
                    chrome.tabs.remove(tabToClose, () => { void chrome.runtime.lastError; });
                }, 400);
            }
            break;
    }
});

// ── Download tracking ──────────────────────────────────────────────────────────
chrome.downloads.onChanged.addListener(delta => {
    if (!delta.state) return;
    const tabId = state.pendingDownloads.get(delta.id);
    if (tabId === undefined) return;

    if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
        state.pendingDownloads.delete(delta.id);
        closeTabAndAdvance(tabId);
    }
});

// ── Core chain logic ───────────────────────────────────────────────────────────
function openNextPrompt() {
    if (state.currentIndex >= state.prompts.length) {
        state.currentTabId = null;
        return; // All prompts done
    }

    chrome.tabs.create({ url: 'https://chatgpt.com/', active: true }, tab => {
        state.currentTabId = tab.id;
        // The content script will fire 'contentReady' once the page loads;
        // we react to that in the message listener above.
    });
}

// Wait a human-like delay so ChatGPT's React UI is fully initialised, then
// send the current prompt to the content script.
function schedulePromptForTab(tabId) {
    const delay = randomInt(2500, 4500);
    setTimeout(() => {
        const prompt = state.prompts[state.currentIndex];
        if (prompt === undefined) return;
        chrome.tabs.sendMessage(tabId, {
            action: 'executePrompt',
            prompt,
            promptIndex: state.currentIndex + 1,
            total: state.prompts.length
        });
    }, delay);
}

function handlePromptDone(tabId, text, promptIndex) {
    const safeText = text || '';
    const filename  = `prompt-${promptIndex}-response.txt`;
    // data: URLs are supported by chrome.downloads and avoid needing a server
    const dataUrl   = 'data:text/plain;charset=utf-8,' + encodeURIComponent(safeText);

    chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, downloadId => {
        if (chrome.runtime.lastError || downloadId === undefined) {
            // Download API failed — still advance so the chain doesn't get stuck
            closeTabAndAdvance(tabId);
            return;
        }
        state.pendingDownloads.set(downloadId, tabId);
    });
}

function closeTabAndAdvance(tabId) {
    state.currentIndex++;
    chrome.tabs.remove(tabId, () => {
        if (chrome.runtime.lastError) { /* tab was already closed — ignore */ }
        // Human-like pause before opening the next tab
        setTimeout(openNextPrompt, randomInt(1500, 3500));
    });
}

// ── Utility ────────────────────────────────────────────────────────────────────
function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
