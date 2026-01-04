document.addEventListener('DOMContentLoaded', restoreSettings);

const els = {
    binance: {
        toggle: document.getElementById('toggle-binance'),
        key: document.getElementById('binance-key'),
        secret: document.getElementById('binance-secret'),
        env: document.getElementById('binance-env'),
        body: document.getElementById('body-binance'),
        head: document.getElementById('head-binance'),
        dot: document.getElementById('dot-binance')
    },
    bybit: {
        toggle: document.getElementById('toggle-bybit'),
        key: document.getElementById('bybit-key'),
        secret: document.getElementById('bybit-secret'),
        env: document.getElementById('bybit-env'),
        body: document.getElementById('body-bybit'),
        head: document.getElementById('head-bybit'),
        dot: document.getElementById('dot-bybit')
    },
    global: {
        sizingVal: document.getElementById('sizing-value'),
        leverage: document.getElementById('leverage'),
        btnSave: document.getElementById('btn-save'),
        status: document.getElementById('status'),
        sizingIcon: document.getElementById('sizing-icon')
    }
};

// Toggle UI Logic
['binance', 'bybit'].forEach(ex => {
    els[ex].head.addEventListener('click', () => els[ex].body.classList.toggle('open'));
    els[ex].toggle.addEventListener('change', () => {
        if (els[ex].toggle.checked) els[ex].dot.classList.add('active');
        else els[ex].dot.classList.remove('active');
    });
});

// Sizing Icon Update ($ or %)
document.querySelectorAll('input[name="sizing"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
        els.global.sizingIcon.textContent = e.target.value === 'percent' ? '%' : '$';
    });
});

document.getElementById('btn-save').addEventListener('click', () => {
    const config = {
        exchanges: {
            binance: {
                active: els.binance.toggle.checked,
                apiKey: els.binance.key.value.trim(),
                apiSecret: els.binance.secret.value.trim(),
                baseUrl: els.binance.env.value
            },
            bybit: {
                active: els.bybit.toggle.checked,
                apiKey: els.bybit.key.value.trim(),
                apiSecret: els.bybit.secret.value.trim(),
                baseUrl: els.bybit.env.value
            }
        },
        global: {
            sizingMode: document.querySelector('input[name="sizing"]:checked').value,
            sizingValue: parseFloat(els.global.sizingVal.value) || 0,
            leverage: parseInt(els.global.leverage.value) || 1
        }
    };

    chrome.storage.local.set({ bridgeConfig: config }, () => {
        els.global.status.style.display = 'block';
        setTimeout(() => els.global.status.style.display = 'none', 1500);
    });
});

function restoreSettings() {
    chrome.storage.local.get("bridgeConfig", (data) => {
        if (!data.bridgeConfig) return;
        const c = data.bridgeConfig;

        // Restore Exchanges
        ['binance', 'bybit'].forEach(ex => {
            if (c.exchanges?.[ex]) {
                const conf = c.exchanges[ex];
                els[ex].toggle.checked = conf.active;
                els[ex].key.value = conf.apiKey || "";
                els[ex].secret.value = conf.apiSecret || "";
                els[ex].env.value = conf.baseUrl;
                if (conf.active) els[ex].dot.classList.add('active');
            }
        });

        // Restore Globals
        if (c.global) {
            els.global.sizingVal.value = c.global.sizingValue;
            els.global.leverage.value = c.global.leverage;
            document.querySelector(`input[value="${c.global.sizingMode}"]`).checked = true;
            els.global.sizingIcon.textContent = c.global.sizingMode === 'percent' ? '%' : '$';
        }
    });
}