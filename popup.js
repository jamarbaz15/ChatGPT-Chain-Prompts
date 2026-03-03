document.addEventListener('DOMContentLoaded', function () {
    // ── Progress bar ──────────────────────────────────────────────────────────
    function updateProgress() {
        chrome.runtime.sendMessage({ action: 'getProgress' }, response => {
            if (chrome.runtime.lastError || !response) return;
            const { done, total } = response;
            const section = document.getElementById('progress-section');

            if (total === 0) {
                section.style.display = 'none';
                return;
            }

            section.style.display = 'block';
            const pct = Math.round((done / total) * 100);
            const bar = document.getElementById('progress-bar');
            bar.style.width = pct + '%';
            document.getElementById('progress-text').textContent =
                `${done} / ${total} prompt${total !== 1 ? 's' : ''}`;

            if (done === total) {
                document.getElementById('progress-status').textContent = '✓ All done!';
                bar.style.background = '#198754'; // green when complete
            } else {
                document.getElementById('progress-status').textContent =
                    `Prompt ${done + 1} running…`;
                bar.style.background = '#0d6efd'; // blue while running
            }
        });
    }

    // Poll every 500 ms while popup is open; clean up on close
    updateProgress();
    const progressInterval = setInterval(updateProgress, 500);
    window.addEventListener('unload', () => clearInterval(progressInterval));

    // Load saved prompts
    chrome.storage.sync.get(['prompts', 'separator'], function (result) {
        const prompts = result.prompts || [];
        if (result.separator) {
            document.getElementById('separator').value = result.separator;
        }
        displayPrompts(prompts);
    });

    // Save separator when it changes and refresh display to update preview formatting
    document.getElementById('separator').addEventListener('change', function () {
        chrome.storage.sync.set({ separator: this.value });
        chrome.storage.sync.get(['prompts'], function (result) {
            displayPrompts(result.prompts || []);
        });
    });

    // Stop the running chain
    document.getElementById('stop-chain').addEventListener('click', function () {
        chrome.runtime.sendMessage({ action: 'stopChain' });
    });

    // Save new prompt
    document.getElementById('save-prompt').addEventListener('click', function () {
        const promptText = document.getElementById('new-prompt').value;
        if (promptText) {
            chrome.storage.sync.get(['prompts'], function (result) {
                const prompts = result.prompts || [];
                prompts.push(promptText);
                chrome.storage.sync.set({ prompts }, function () {
                    displayPrompts(prompts);
                    document.getElementById('new-prompt').value = '';
                });
            });
        }
    });
    
    function displayPrompts(prompts) {
        const promptsList = document.getElementById('prompts-list');
        promptsList.innerHTML = '';

        prompts.forEach((prompt, index) => {
            const div = document.createElement('div');
            div.className = 'prompt-item';

            // Format the preview text based on separator
            const separator = document.getElementById('separator').value;
            const formattedPrompt = separator.toLowerCase() === '\\n' || separator === '\n'
                ? prompt  // Keep original formatting for newlines
                : prompt.split(separator).join('\n' + separator + '\n');  // Format other separators

            // Build structure without user content in innerHTML to prevent XSS
            div.innerHTML = `
            <div class="preview-mode">
                <div class="prompt-preview"></div>
                <div class="button-group">
                    <button class="use-prompt">Use Prompt Chain</button>
                    <button class="edit-prompt" data-index="${index}">Edit</button>
                    <button class="delete-prompt" data-index="${index}">Delete</button>
                </div>
            </div>
            <div class="edit-mode" style="display: none;">
                <textarea class="edit-textarea"></textarea>
                <div class="button-group">
                    <button class="save-edit" data-index="${index}">Save</button>
                    <button class="cancel-edit">Cancel</button>
                </div>
            </div>
        `;

            // Safely inject user content via DOM properties, not innerHTML
            div.querySelector('.prompt-preview').textContent = formattedPrompt;
            div.querySelector('.use-prompt').dataset.prompt = prompt;
            div.querySelector('.edit-textarea').value = prompt;

            promptsList.appendChild(div);
        });

        // Add event listeners for use and delete buttons
        document.querySelectorAll('.use-prompt').forEach(button => {
            button.addEventListener('click', function () {
                const rawPrompt = this.dataset.prompt;
                const separator = document.getElementById('separator').value;

                // Split the raw prompt into individual prompts here so background
                // receives a clean array and doesn't need to know the separator.
                let prompts;
                if (separator.toLowerCase() === '\\n' || separator === '\n') {
                    prompts = rawPrompt.split(/\n+/).map(p => p.trim()).filter(p => p);
                } else {
                    prompts = rawPrompt.split(separator).map(p => p.trim()).filter(p => p);
                }

                if (prompts.length > 0) {
                    // Hand off to the background service worker which manages
                    // opening tabs, downloading responses, and advancing the chain.
                    chrome.runtime.sendMessage({ action: 'startChain', prompts });
                }
            });
        });

        document.querySelectorAll('.delete-prompt').forEach(button => {
            button.addEventListener('click', function () {
                const index = parseInt(this.getAttribute('data-index'));
                chrome.storage.sync.get(['prompts'], function (result) {
                    const prompts = result.prompts || [];
                    prompts.splice(index, 1);
                    chrome.storage.sync.set({ prompts }, function () {
                        displayPrompts(prompts);
                    });
                });
            });
        });

        document.querySelectorAll('.edit-prompt').forEach(button => {
            button.addEventListener('click', function () {
                const index = this.getAttribute('data-index');
                const promptItem = this.closest('.prompt-item');
                promptItem.querySelector('.preview-mode').style.display = 'none';
                promptItem.querySelector('.edit-mode').style.display = 'block';
            });
        });

        document.querySelectorAll('.save-edit').forEach(button => {
            button.addEventListener('click', function () {
                const index = parseInt(this.getAttribute('data-index'));
                const promptItem = this.closest('.prompt-item');
                const newText = promptItem.querySelector('.edit-textarea').value;

                chrome.storage.sync.get(['prompts'], function (result) {
                    const prompts = result.prompts || [];
                    prompts[index] = newText;
                    chrome.storage.sync.set({ prompts }, function () {
                        displayPrompts(prompts);
                    });
                });
            });
        });

        document.querySelectorAll('.cancel-edit').forEach(button => {
            button.addEventListener('click', function () {
                const promptItem = this.closest('.prompt-item');
                promptItem.querySelector('.preview-mode').style.display = 'block';
                promptItem.querySelector('.edit-mode').style.display = 'none';
            });
        });
    }
});