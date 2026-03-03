let currentChain = null;
let isProcessing = false;

//Check if ChatGPT is ready for next input
function isResponseComplete() {
    return document.querySelector('button[data-state="closed"]')!=null;
}

function submitPrompt(prompt) {
    const textarea = document.querySelector('#prompt-textarea');

    // Set the content
    textarea.textContent = prompt;

    // Create and dispatch input event
    const inputEvent = new Event('input', { bubbles: true });
    textarea.dispatchEvent(inputEvent);

    // Find and click the submit button
    const checkButtonExistence = setInterval(() => {
        const button = document.querySelector('button[aria-label="Send prompt"][data-testid="send-button"]');
        if (button) {
            clearInterval(checkButtonExistence);  // Stop checking once the button is found
            button.click();  // Click the button
        }
    }, 100);  // Check every 100ms


}

//process the next prompt in chain
async function processNextPrompt() {
    if (!currentChain || currentChain.length === 0 || isProcessing) {
        currentChain = null;
        isProcessing = false;
        return;
    }

    isProcessing = true;
    const nextPrompt = currentChain[0];
    currentChain = currentChain.slice(1);

    submitPrompt(nextPrompt);

    // Start checking for completion
    waitForCompletion();
}

// Function to wait for ChatGPT to complete its response
function waitForCompletion() {
    // Phase 1: wait for ChatGPT to START generating (stop button appears)
    const waitForStart = setInterval(() => {
        const isGenerating =
            document.querySelector('button[aria-label="Stop streaming"]') !== null ||
            document.querySelector('button[data-testid="stop-button"]') !== null;
        if (isGenerating) {
            clearInterval(waitForStart);

            // Phase 2: wait for ChatGPT to FINISH generating (stop button gone, send button back)
            const waitForEnd = setInterval(() => {
                if (isResponseComplete()) {
                    clearInterval(waitForEnd);
                    isProcessing = false;

                    // Wait a short moment before processing next prompt
                    setTimeout(() => {
                        processNextPrompt();
                    }, 1000);
                }
            }, 1000);
        }
    }, 500);
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (request.action === 'usePrompt') {
        let separator = request.separator || '---';

        // Special handling for newline separator
        if (separator.toLowerCase() === '\\n' || separator === '\n') {
            currentChain = request.prompt.split(/\n+/).map(p => p.trim()).filter(p => p);
        } else {
            currentChain = request.prompt.split(separator).map(p => p.trim()).filter(p => p);
        }

        // Start the chain
        if (currentChain.length > 0 && !isProcessing) {
            processNextPrompt();
        }
    }
});