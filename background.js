console.log("🔥 Universal Bridge Engine v5.1 (Edit Pending Fixed)");

// --- CACHE ---
let binanceExchangeInfo = null;
let bybitExchangeInfo = null;

// --- ROUTER ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "TV_TRADE_EXECUTED") {
        const { action, data } = message;
        console.log(`📩 ACTION: ${action}`, data);

        if (action === "CLOSE") handleClose(data);
        else if (action === "CANCEL") handleCancel(data);
        else if (action === "MODIFY_POSITION") handleModifyPosition(data); // Renamed for clarity
        else if (action === "EDIT") handleEditOrder(data); // <--- NEW
        else handleOpen(data);
    }
});

// =================================================================
// 1️⃣ ORCHESTRATORS
// =================================================================

async function handleOpen(tvData) {
    const config = await getConfig();
    if (!config || !tvData.side) return;

    const promises = [];
    if (config.exchanges.binance?.active) promises.push(openBinance(tvData, config.exchanges.binance, config.global));
    if (config.exchanges.bybit?.active) promises.push(openBybit(tvData, config.exchanges.bybit, config.global));
    await Promise.all(promises);
}

// 🆕 EDIT HANDLER (Cancel Old -> Place New)
async function handleEditOrder(tvData) {
    console.log("✏️ Editing Pending Order...");
    // 1. Wipe existing limit orders for this symbol
    await handleCancel(tvData);

    // 2. Wait a tiny bit for API to process cancel
    await new Promise(r => setTimeout(r, 500));

    // 3. Place the new updated order
    await handleOpen(tvData);
}

async function handleModifyPosition(tvData) {
    const config = await getConfig();
    if (!config) return;

    const promises = [];
    if (config.exchanges.binance?.active) promises.push(modifyBinance(tvData, config.exchanges.binance));
    if (config.exchanges.bybit?.active) promises.push(modifyBybit(tvData, config.exchanges.bybit));
    await Promise.all(promises);
}

async function handleClose(tvData) {
    const config = await getConfig();
    if (!config) return;
    const promises = [];
    if (config.exchanges.binance?.active) promises.push(closeBinance(tvData, config.exchanges.binance));
    if (config.exchanges.bybit?.active) promises.push(closeBybit(tvData, config.exchanges.bybit));
    await Promise.all(promises);
}

async function handleCancel(tvData) {
    const config = await getConfig();
    if (!config) return;
    const promises = [];
    if (config.exchanges.binance?.active) promises.push(cancelBinance(tvData, config.exchanges.binance));
    if (config.exchanges.bybit?.active) promises.push(cancelBybit(tvData, config.exchanges.bybit));
    await Promise.all(promises);
}

// =================================================================
// 🔵 BINANCE LOGIC
// =================================================================

async function openBinance(tvData, keys, global) {
    if (!keys.apiKey || !tvData.side) return;
    const symbol = normalizeSymbol(tvData.symbol);
    const baseUrl = keys.baseUrl;

    try {
        const filters = await getBinanceSymbolFilters(symbol, baseUrl);
        const maxLev = await getBinanceMaxLeverage(symbol, baseUrl, keys);
        const finalLev = Math.min(global.leverage, maxLev);
        await setBinanceLeverage(symbol, finalLev, baseUrl, keys);

        const price = await getBinancePrice(symbol, baseUrl);
        let qty = await calculateQty(symbol, price, finalLev, global, 'binance', baseUrl, keys);
        qty = roundToStep(qty, filters.stepSize);

        if (parseFloat(qty) <= 0) return notify("Binance Error", "Qty too small");

        const params = {
            symbol, side: tvData.side.toUpperCase(), type: tvData.type.toUpperCase(), quantity: qty, timestamp: Date.now()
        };

        if (params.type === "LIMIT") {
            params.price = roundToStep(tvData.price, filters.tickSize);
            params.timeInForce = "GTC";
        }

        const qs = new URLSearchParams(params);
        qs.append("signature", await signBinance(qs.toString(), keys.apiSecret));

        const res = await fetch(`${baseUrl}/fapi/v1/order?${qs.toString()}`, { method: "POST", headers: { "X-MBX-APIKEY": keys.apiKey } });
        const json = await res.json();
        if (json.code) throw new Error(json.msg);

        notify(`Binance: ${tvData.side} ${symbol}`, `Lev: ${finalLev}x`);

        // TP/SL
        if (tvData.tp || tvData.sl) {
            await new Promise(r => setTimeout(r, 1000));
            const closeSide = tvData.side.toUpperCase() === "BUY" ? "SELL" : "BUY";
            if (tvData.tp) await placeBinanceTPSL(symbol, closeSide, qty, tvData.tp, "TAKE_PROFIT_MARKET", baseUrl, keys, filters);
            if (tvData.sl) await placeBinanceTPSL(symbol, closeSide, qty, tvData.sl, "STOP_MARKET", baseUrl, keys, filters);
        }
    } catch (e) { notify("Binance Fail", e.message); console.error(e); }
}

async function modifyBinance(tvData, keys) {
    const symbol = normalizeSymbol(tvData.symbol);
    const baseUrl = keys.baseUrl;
    try {
        const filters = await getBinanceSymbolFilters(symbol, baseUrl);
        const qs = `symbol=${symbol}&timestamp=${Date.now()}`;
        const sig = await signBinance(qs, keys.apiSecret);
        const res = await fetch(`${baseUrl}/fapi/v2/positionRisk?${qs}&signature=${sig}`, { headers: { "X-MBX-APIKEY": keys.apiKey } });
        const data = await res.json();
        const pos = Array.isArray(data) ? data.find(p => parseFloat(p.positionAmt) !== 0) : data;

        if (!pos || parseFloat(pos.positionAmt) === 0) return;

        const amt = Math.abs(parseFloat(pos.positionAmt));
        const closeSide = parseFloat(pos.positionAmt) > 0 ? "SELL" : "BUY";

        const qsOrders = `symbol=${symbol}&timestamp=${Date.now()}`;
        const sigOrders = await signBinance(qsOrders, keys.apiSecret);
        const resOrders = await fetch(`${baseUrl}/fapi/v1/openOrders?${qsOrders}&signature=${sigOrders}`, { headers: { "X-MBX-APIKEY": keys.apiKey } });
        const openOrders = await resOrders.json();

        if ("tp" in tvData) {
            const oldTP = openOrders.filter(o => o.type.includes("TAKE_PROFIT"));
            for (const o of oldTP) await cancelBinanceOrder(symbol, o.orderId, baseUrl, keys);
            if (tvData.tp > 0) await placeBinanceTPSL(symbol, closeSide, amt, tvData.tp, "TAKE_PROFIT_MARKET", baseUrl, keys, filters);
        }

        if ("sl" in tvData) {
            const oldSL = openOrders.filter(o => o.type.includes("STOP"));
            for (const o of oldSL) await cancelBinanceOrder(symbol, o.orderId, baseUrl, keys);
            if (tvData.sl > 0) await placeBinanceTPSL(symbol, closeSide, amt, tvData.sl, "STOP_MARKET", baseUrl, keys, filters);
        }
        notify("Binance Update", "TP/SL Modified");
    } catch (e) { console.error(e); }
}

async function closeBinance(tvData, keys) {
    const symbol = normalizeSymbol(tvData.symbol);
    try {
        const qs = `symbol=${symbol}&timestamp=${Date.now()}`;
        const sig = await signBinance(qs, keys.apiSecret);
        const res = await fetch(`${keys.baseUrl}/fapi/v2/positionRisk?${qs}&signature=${sig}`, { headers: { "X-MBX-APIKEY": keys.apiKey } });
        const data = await res.json();
        const pos = Array.isArray(data) ? data.find(p => parseFloat(p.positionAmt) !== 0) : data;

        if (!pos || parseFloat(pos.positionAmt) === 0) return;

        const amt = parseFloat(pos.positionAmt);
        const side = amt > 0 ? "SELL" : "BUY";
        const params = new URLSearchParams({ symbol, side, type: "MARKET", quantity: Math.abs(amt), reduceOnly: "true", timestamp: Date.now() });
        params.append("signature", await signBinance(params.toString(), keys.apiSecret));

        await fetch(`${keys.baseUrl}/fapi/v1/order?${params.toString()}`, { method: "POST", headers: { "X-MBX-APIKEY": keys.apiKey } });
        await cancelBinance(tvData, keys);
        notify("Binance Closed", symbol);
    } catch (e) { console.error(e); }
}

async function cancelBinance(tvData, keys) {
    const symbol = normalizeSymbol(tvData.symbol);
    const qs = `symbol=${symbol}&timestamp=${Date.now()}`;
    const sig = await signBinance(qs, keys.apiSecret);
    await fetch(`${keys.baseUrl}/fapi/v1/allOpenOrders?${qs}&signature=${sig}`, { method: "DELETE", headers: { "X-MBX-APIKEY": keys.apiKey } });
}

// =================================================================
// 🟠 BYBIT LOGIC
// =================================================================

async function openBybit(tvData, keys, global) {
    if (!keys.apiKey || !tvData.side) return;
    const symbol = normalizeSymbol(tvData.symbol);
    const baseUrl = keys.baseUrl;

    try {
        const filters = await getBybitInstrumentInfo(symbol, baseUrl);
        const maxLev = parseFloat(filters.maxLeverage) || 20;
        const finalLev = Math.min(global.leverage, maxLev);
        await setBybitLeverage(symbol, finalLev, baseUrl, keys);

        const price = await getBybitPrice(symbol, baseUrl);
        let qty = await calculateQty(symbol, price, finalLev, global, 'bybit', baseUrl, keys);
        qty = roundToStep(qty, filters.qtyStep);

        if (parseFloat(qty) <= 0) return notify("Bybit Error", "Qty too small");

        const side = tvData.side.charAt(0).toUpperCase() + tvData.side.slice(1).toLowerCase();
        const type = tvData.type === "limit" ? "Limit" : "Market";

        const params = {
            category: "linear", symbol, side, orderType: type, qty: qty.toString(),
            ...(type === "Limit" && { price: roundToStep(tvData.price, filters.priceStep) }),
            ...(tvData.tp && { takeProfit: roundToStep(tvData.tp, filters.priceStep) }),
            ...(tvData.sl && { stopLoss: roundToStep(tvData.sl, filters.priceStep) })
        };

        await sendBybitRequest(baseUrl, "/v5/order/create", "POST", params, keys);
        notify(`Bybit: ${side} ${symbol}`, `Lev: ${finalLev}x`);

    } catch (e) { notify("Bybit Fail", e.message); }
}

async function modifyBybit(tvData, keys) {
    const symbol = normalizeSymbol(tvData.symbol);
    const baseUrl = keys.baseUrl;
    try {
        const filters = await getBybitInstrumentInfo(symbol, baseUrl);
        const res = await sendBybitRequest(baseUrl, "/v5/position/list", "GET", { category: "linear", symbol }, keys);
        const pos = res.result.list.find(p => parseFloat(p.size) > 0);

        if (!pos) return;

        const params = { category: "linear", symbol, positionIdx: pos.positionIdx };
        if ("tp" in tvData) params.takeProfit = tvData.tp > 0 ? roundToStep(tvData.tp, filters.priceStep) : "0";
        if ("sl" in tvData) params.stopLoss = tvData.sl > 0 ? roundToStep(tvData.sl, filters.priceStep) : "0";

        await sendBybitRequest(baseUrl, "/v5/position/trading-stop", "POST", params, keys);
        notify("Bybit Update", "TP/SL Modified");
    } catch (e) { console.error(e); }
}

async function closeBybit(tvData, keys) {
    const symbol = normalizeSymbol(tvData.symbol);
    const baseUrl = keys.baseUrl;
    try {
        const res = await sendBybitRequest(baseUrl, "/v5/position/list", "GET", { category: "linear", symbol }, keys);
        const pos = res.result.list.find(p => parseFloat(p.size) > 0);
        if (!pos) return;

        const side = pos.side === "Buy" ? "Sell" : "Buy";
        await sendBybitRequest(baseUrl, "/v5/order/create", "POST", { category: "linear", symbol, side, orderType: "Market", qty: pos.size, reduceOnly: true }, keys);
        await cancelBybit(tvData, keys);
        notify("Bybit Closed", symbol);
    } catch (e) { notify("Bybit Close Fail", e.message); }
}

async function cancelBybit(tvData, keys) {
    const symbol = normalizeSymbol(tvData.symbol);
    try {
        await sendBybitRequest(keys.baseUrl, "/v5/order/cancel-all", "POST", { category: "linear", symbol }, keys);
    } catch (e) { }
}

// =================================================================
// 🔐 HELPERS
// =================================================================

async function getConfig() {
    const data = await chrome.storage.local.get("bridgeConfig");
    return data.bridgeConfig;
}

function roundToStep(value, stepSize) {
    value = parseFloat(value);
    stepSize = parseFloat(stepSize);
    if (!stepSize) return value.toFixed(4);
    const steps = Math.floor(value / stepSize);
    const rounded = steps * stepSize;
    const decimals = (stepSize.toString().split('.')[1] || '').length;
    return rounded.toFixed(decimals);
}

// BINANCE UTILS
async function getBinanceSymbolFilters(symbol, url) {
    if (binanceExchangeInfo) {
        const s = binanceExchangeInfo.find(x => x.symbol === symbol);
        if (s) return parseBinanceFilters(s);
    }
    try {
        const res = await fetch(`${url}/fapi/v1/exchangeInfo`);
        const data = await res.json();
        binanceExchangeInfo = data.symbols;
        const s = data.symbols.find(x => x.symbol === symbol);
        return parseBinanceFilters(s);
    } catch (e) { return { tickSize: "0.01", stepSize: "0.001" }; }
}

function parseBinanceFilters(s) {
    if (!s) return { tickSize: "0.01", stepSize: "0.001" };
    const p = s.filters.find(f => f.filterType === 'PRICE_FILTER');
    const l = s.filters.find(f => f.filterType === 'LOT_SIZE');
    return { tickSize: p ? p.tickSize : "0.01", stepSize: l ? l.stepSize : "0.001" };
}

async function getBinancePrice(symbol, url) {
    const res = await fetch(`${url}/fapi/v1/ticker/price?symbol=${symbol}`);
    const d = await res.json();
    return parseFloat(d.price);
}

async function getBinanceMaxLeverage(symbol, url, keys) {
    try {
        const qs = `symbol=${symbol}&timestamp=${Date.now()}`;
        const sig = await signBinance(qs, keys.apiSecret);
        const res = await fetch(`${url}/fapi/v1/leverageBracket?${qs}&signature=${sig}`, { headers: { "X-MBX-APIKEY": keys.apiKey } });
        const data = await res.json();
        return Array.isArray(data) ? data[0].brackets[0].initialLeverage : 20;
    } catch (e) { return 20; }
}

async function setBinanceLeverage(symbol, lev, url, keys) {
    try {
        const qs = `symbol=${symbol}&leverage=${lev}&timestamp=${Date.now()}`;
        const sig = await signBinance(qs, keys.apiSecret);
        await fetch(`${url}/fapi/v1/leverage?${qs}&signature=${sig}`, { method: "POST", headers: { "X-MBX-APIKEY": keys.apiKey } });
    } catch (e) { }
}

async function cancelBinanceOrder(symbol, orderId, url, keys) {
    const qs = `symbol=${symbol}&orderId=${orderId}&timestamp=${Date.now()}`;
    const sig = await signBinance(qs, keys.apiSecret);
    await fetch(`${url}/fapi/v1/order?${qs}&signature=${sig}`, { method: "DELETE", headers: { "X-MBX-APIKEY": keys.apiKey } });
}

async function placeBinanceTPSL(symbol, side, qty, stopPrice, type, url, keys, filters) {
    const price = roundToStep(stopPrice, filters.tickSize);
    const qs = new URLSearchParams({
        symbol, side, type, stopPrice: price, quantity: qty, workingType: "MARK_PRICE", closePosition: "true", timestamp: Date.now()
    });
    qs.append("signature", await signBinance(qs.toString(), keys.apiSecret));
    await fetch(`${url}/fapi/v1/order?${qs.toString()}`, { method: "POST", headers: { "X-MBX-APIKEY": keys.apiKey } });
}

// BYBIT UTILS
async function getBybitInstrumentInfo(symbol, url) {
    if (bybitExchangeInfo && bybitExchangeInfo[symbol]) return bybitExchangeInfo[symbol];
    try {
        const res = await fetch(`${url}/v5/market/instruments-info?category=linear&symbol=${symbol}`);
        const data = await res.json();
        const info = data.result.list[0];
        const result = { qtyStep: info.lotSizeFilter.qtyStep, priceStep: info.priceFilter.tickSize, maxLeverage: info.leverageFilter.maxLeverage };
        if (!bybitExchangeInfo) bybitExchangeInfo = {};
        bybitExchangeInfo[symbol] = result;
        return result;
    } catch (e) { return { qtyStep: "0.001", priceStep: "0.01", maxLeverage: "20" }; }
}

async function getBybitPrice(symbol, url) {
    const res = await fetch(`${url}/v5/market/tickers?category=linear&symbol=${symbol}`);
    const data = await res.json();
    return parseFloat(data.result.list[0].lastPrice);
}

async function setBybitLeverage(symbol, lev, url, keys) {
    try {
        await sendBybitRequest(url, "/v5/position/set-leverage", "POST", { category: "linear", symbol, buyLeverage: lev.toString(), sellLeverage: lev.toString() }, keys);
    } catch (e) { }
}

async function sendBybitRequest(baseUrl, endpoint, method, params, keys) {
    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    let paramString = method === "POST" ? JSON.stringify(params) : new URLSearchParams(params).toString();
    const payload = timestamp + keys.apiKey + recvWindow + paramString;
    const signature = await signBinance(payload, keys.apiSecret);
    let url = baseUrl + endpoint;
    if (method === "GET" && paramString) url += "?" + paramString;

    const res = await fetch(url, {
        method: method,
        headers: { "X-BAPI-API-KEY": keys.apiKey, "X-BAPI-SIGN": signature, "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recvWindow, "Content-Type": "application/json" },
        body: method === "POST" ? paramString : null
    });
    const json = await res.json();
    if (json.retCode !== 0) throw new Error(`${json.retMsg} (${json.retCode})`);
    return json;
}

// SHARED UTILS
async function calculateQty(symbol, price, leverage, global, exchange, url, keys) {
    let margin = global.sizingValue;
    if (global.sizingMode === "percent") {
        let balance = 0;
        if (exchange === 'binance') balance = await getBinanceBalance(url, keys);
        if (exchange === 'bybit') balance = await getBybitBalance(url, keys);
        margin = balance * (global.sizingValue / 100);
    }
    return (margin * leverage) / price;
}

async function getBinanceBalance(url, keys) {
    try {
        const qs = `timestamp=${Date.now()}`;
        const sig = await signBinance(qs, keys.apiSecret);
        const res = await fetch(`${url}/fapi/v2/balance?${qs}&signature=${sig}`, { headers: { "X-MBX-APIKEY": keys.apiKey } });
        const d = await res.json();
        const asset = d.find(a => a.asset === "USDT");
        return asset ? parseFloat(asset.availableBalance) : 0;
    } catch (e) { return 0; }
}

async function getBybitBalance(url, keys) {
    try {
        const res = await sendBybitRequest(url, "/v5/account/wallet-balance", "GET", { accountType: "UNIFIED", coin: "USDT" }, keys);
        return parseFloat(res.result.list[0].coin[0].walletBalance);
    } catch (e) { return 0; }
}

async function signBinance(query, secret) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(query));
    return [...new Uint8Array(signed)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeSymbol(raw) {
    if (!raw) return "UNDEFINED";
    let s = raw.split(":")[1] || raw;
    s = s.replace(".P", "").replace("/", "");
    if (!s.endsWith("USDT") && s.endsWith("USD")) s = s.replace("USD", "USDT");
    return s.toUpperCase();
}

function notify(title, msg) {
    if (chrome.notifications) chrome.notifications.create({ type: "basic", iconUrl: "icon.png", title, message: msg });
}