/**
 * debug-viewer.js — Multihog D&D Framework
 * A high-fidelity context viewer for inspecting LLM input and output.
 */

import { escapeHtml } from './memo-processor.js';

let transactions = [];
let isOpen = false;
let debugPanel = null;

export function initializeDebugViewer() {
    if (debugPanel) return;
    
    debugPanel = document.createElement('div');
    debugPanel.id = 'rpg-debug-viewer';
    debugPanel.className = 'rpg-debug-viewer';
    debugPanel.style.display = 'none';
    
    // Aesthetic structure
    debugPanel.innerHTML = `
        <div class="rt-resizer-tr" id="rt-debug-resizer-tr" title="Resize from top-right"></div>
        <div class="rt-resizer-br" id="rt-debug-resizer-br" title="Resize from bottom-right"></div>
        <div class="rpg-debug-header">
            <div class="rpg-debug-header-left">
                <span class="rpg-debug-icon">🛠️</span>
                <span class="rpg-debug-title">Context Debugger</span>
            </div>
            <div class="rpg-debug-header-right">
                <button id="rpg-debug-clear" title="Clear History">🧹</button>
                <button id="rpg-debug-close">✕</button>
            </div>
        </div>
        <div class="rpg-debug-content">
            <div class="rpg-debug-empty">No transactions logged yet.</div>
        </div>
    `;
    
    document.body.appendChild(debugPanel);
    
    // Geometry Key
    const GEO_KEY = 'rpg_tracker_geometry_debug_viewer';

    // Restore geometry
    try {
        const saved = JSON.parse(localStorage.getItem(GEO_KEY));
        if (saved && saved.left !== undefined) {
            const left = Math.max(0, Math.min(window.innerWidth - 50, saved.left));
            const top = Math.max(0, Math.min(window.innerHeight - 50, saved.top));
            debugPanel.style.left = left + 'px';
            debugPanel.style.top = top + 'px';
            if (saved.width) debugPanel.style.width = saved.width + 'px';
            if (saved.height) debugPanel.style.height = saved.height + 'px';
        }
    } catch (_) {}

    const saveGeometry = () => {
        const rect = debugPanel.getBoundingClientRect();
        localStorage.setItem(GEO_KEY, JSON.stringify({
            left: rect.left, top: rect.top,
            width: rect.width, height: rect.height
        }));
    };

    // Events
    debugPanel.querySelector('#rpg-debug-close').onclick = () => toggleDebugViewer(false);
    debugPanel.querySelector('#rpg-debug-clear').onclick = () => {
        transactions = [];
        renderTransactions();
    };
    
    // Draggable (using pointer events)
    const header = debugPanel.querySelector('.rpg-debug-header');
    let isDragging = false;
    let dragStartX, dragStartY, dragStartLeft, dragStartTop;

    header.onpointerdown = (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('button')) return; // Avoid drag on button click
        isDragging = true;
        header.setPointerCapture(e.pointerId);
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        const rect = debugPanel.getBoundingClientRect();
        dragStartLeft = rect.left;
        dragStartTop = rect.top;
        
        e.preventDefault();
    };

    header.onpointermove = (e) => {
        if (!isDragging) return;
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        debugPanel.style.left = (dragStartLeft + dx) + 'px';
        debugPanel.style.top = (dragStartTop + dy) + 'px';
    };

    const stopDrag = (e) => {
        if (!isDragging) return;
        isDragging = false;
        if (e) {
            try { header.releasePointerCapture(e.pointerId); } catch (_) {}
        }
        saveGeometry();
    };

    header.onpointerup = stopDrag;
    header.onpointercancel = stopDrag;

    // Resizable Setup
    const resizerTR = debugPanel.querySelector('#rt-debug-resizer-tr');
    const resizerBR = debugPanel.querySelector('#rt-debug-resizer-br');

    const setupResizer = (handle, type) => {
        let isResizing = false;
        let startX, startY, startWidth, startHeight, startTop, startLeft;

        const stopResize = (e) => {
            if (!isResizing) return;
            isResizing = false;
            if (e) {
                try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
            }
            saveGeometry();
        };

        handle.onpointerdown = (e) => {
            if (e.button !== 0) return;
            isResizing = true;
            handle.setPointerCapture(e.pointerId);
            const rect = debugPanel.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            startWidth = rect.width;
            startHeight = rect.height;
            startTop = rect.top;
            startLeft = rect.left;

            // Lock positioning variables to styles
            debugPanel.style.left = startLeft + 'px';
            debugPanel.style.top = startTop + 'px';

            e.preventDefault();
            e.stopPropagation();
        };

        handle.onpointermove = (e) => {
            if (!isResizing) return;
            if (e.buttons === 0) {
                stopResize(e);
                return;
            }
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            if (type === 'TR') {
                const newWidth = Math.max(300, startWidth + dx);
                const newHeight = Math.max(200, startHeight - dy);
                const newTop = startTop + dy;
                debugPanel.style.width = newWidth + 'px';
                if (newHeight > 200) {
                    debugPanel.style.height = newHeight + 'px';
                    debugPanel.style.top = newTop + 'px';
                }
            } else if (type === 'BR') {
                const newWidth = Math.max(300, startWidth + dx);
                const newHeight = Math.max(200, startHeight + dy);
                debugPanel.style.width = newWidth + 'px';
                debugPanel.style.height = newHeight + 'px';
            }
        };

        handle.onpointerup = stopResize;
        handle.onpointercancel = stopResize;
    };

    if (resizerTR) setupResizer(resizerTR, 'TR');
    if (resizerBR) setupResizer(resizerBR, 'BR');
}

export function toggleDebugViewer(force) {
    isOpen = force !== undefined ? force : !isOpen;
    if (debugPanel) {
        debugPanel.style.display = isOpen ? 'flex' : 'none';
        if (isOpen) renderTransactions();
    }
}

export function logTransaction(source, messages, response = null) {
    const transaction = {
        timestamp: new Date().toLocaleTimeString(),
        source, // 'Tracker' or 'Main Chat'
        messages, // [{role: 'system', content: '...'}, {role: 'user', content: '...'}]
        response,
        id: Date.now()
    };
    
    transactions.unshift(transaction);
    if (transactions.length > 10) transactions.pop(); // Keep last 10
    
    if (isOpen) renderTransactions();
}

function renderTransactions() {
    const content = debugPanel.querySelector('.rpg-debug-content');
    if (transactions.length === 0) {
        content.innerHTML = '<div class="rpg-debug-empty">No transactions logged yet.</div>';
        return;
    }
    
    content.innerHTML = transactions.map(t => `
        <div class="rpg-debug-transaction" data-id="${t.id}">
            <div class="rpg-debug-trans-header">
                <span class="rpg-debug-time">${t.timestamp}</span>
                <span class="rpg-debug-source" style="background: ${t.source === 'Tracker' ? 'rgba(0, 255, 170, 0.2)' : 'rgba(255, 150, 0, 0.2)'}; color: ${t.source === 'Tracker' ? '#00ffaa' : '#ffaa00'}; padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 10px;">${t.source.toUpperCase()}</span>
            </div>
            <div class="rpg-debug-trans-body">
                ${t.messages.map(m => `
                    <div class="rpg-debug-section">
                        <div class="rpg-debug-label ${m.role === 'system' ? 'system' : 'input'}">${m.role === 'system' ? 'SYSTEM PROMPT' : 'USER MESSAGE'}</div>
                        <div class="rpg-debug-text">${escapeHtml(m.content)}</div>
                    </div>
                `).join('')}
                ${t.response ? `
                    <div class="rpg-debug-section" style="opacity: 0.6; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 10px;">
                        <div class="rpg-debug-label output">AI RESPONSE (State)</div>
                        <div class="rpg-debug-text response" style="max-height: 100px;">${escapeHtml(t.response)}</div>
                    </div>
                ` : ''}
            </div>
        </div>
    `).join('');
}
