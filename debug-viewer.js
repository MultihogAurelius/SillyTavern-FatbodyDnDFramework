/**
 * debug-viewer.js — Fatbody D&D Framework
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
    
    // Events
    debugPanel.querySelector('#rpg-debug-close').onclick = () => toggleDebugViewer(false);
    debugPanel.querySelector('#rpg-debug-clear').onclick = () => {
        transactions = [];
        renderTransactions();
    };
    
    // Draggable (simple implementation)
    const header = debugPanel.querySelector('.rpg-debug-header');
    let isDragging = false;
    let offset = [0, 0];
    
    header.onmousedown = (e) => {
        isDragging = true;
        offset = [debugPanel.offsetLeft - e.clientX, debugPanel.offsetTop - e.clientY];
    };
    
    document.onmousemove = (e) => {
        if (!isDragging) return;
        debugPanel.style.left = (e.clientX + offset[0]) + 'px';
        debugPanel.style.top = (e.clientY + offset[1]) + 'px';
    };
    
    document.onmouseup = () => isDragging = false;
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
