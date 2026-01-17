console.log("🔥 Universal Bridge Engine v8.0 (Deduplication + Safety)");

// --- GLOBAL CACHE ---
let binanceExchangeInfo = null;
let bybitExchangeInfo = {};
let lastMsg = { text: "", time: 0 }; // 🛡️ Anti-Duplicate Cache

// --- ROUTER ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "TV_TRADE_EXECUTED") {

        // 🛑 DEDUPLICATION GUARD
        // Creates a unique signature for this trade command
        const currentSig = JSON.stringify(message.data);
        const now = Date.now();

        // If exact same data received within 1 second, IGNORE IT.
        if (currentSig === lastMsg.text && (now - lastMsg.time) < 1000) {
            console.warn("⚠️ Duplicate signal blocked:", message.action);
            return;
        }

        // Update cache
        lastMsg = { text: currentSig, time: now };

        const { action, data } = message;

        if (action === "CLOSE") handleClose(data);
        else if (action === "CANCEL") handleCancel(data);
        else if (action === "MODIFY_POSITION") handleModifyPosition(data);
        else if (action === "EDIT") handleEditOrder(data);
        else handleOpen(data);
    }
});

// =================================================================
// 1️⃣ ORCHESTRATORS
// =================================================================

async function handleOpen(tvData) {
    const config = await getConfig();
    if (!config || !tvData.side) return console.warn("⚠️ Signal missing side/config");
    if (!tvData.type) tvData.type = "MARKET";

    const promises = [];
    if (config.exchanges.binance?.active) promises.push(openBinance(tvData, config.exchanges.binance, config.global));
    if (config.exchanges.bybit?.active) promises.push(openBybit(tvData, config.exchanges.bybit, config.global));

    await Promise.all(promises);
}

// EDIT: Cancel -> Wait -> Open
async function handleEditOrder(tvData) {
    if (!tvData.side) return;
    await handleCancel(tvData);
    await new Promise(r => setTimeout(r, 400));
    await handleOpen(tvData);
}

async function handleModifyPosition(tvData) {
    const config = await getConfig();
    if (!config) return;
    const p = [];
    if (config.exchanges.binance?.active) p.push(modifyBinance(tvData, config.exchanges.binance));
    if (config.exchanges.bybit?.active) p.push(modifyBybit(tvData, config.exchanges.bybit));
    await Promise.all(p);
}

async function handleClose(tvData) {
    const config = await getConfig();
    if (!config) return;
    const p = [];
    if (config.exchanges.binance?.active) p.push(closeBinance(tvData, config.exchanges.binance));
    if (config.exchanges.bybit?.active) p.push(closeBybit(tvData, config.exchanges.bybit));
    await Promise.all(p);
}

async function handleCancel(tvData) {
    const config = await getConfig();
    if (!config) return;
    const p = [];
    if (config.exchanges.binance?.active) p.push(cancelBinance(tvData, config.exchanges.binance));
    if (config.exchanges.bybit?.active) p.push(cancelBybit(tvData, config.exchanges.bybit));
    await Promise.all(p);
}

// =================================================================
// 🔵 BINANCE LOGIC (SMART CLAMPING)
// =================================================================

async function openBinance(tvData, keys, global) {
    if (!keys.apiKey || !tvData.side) return;
    const symbol = normalizeSymbol(tvData.symbol);
    const baseUrl = keys.baseUrl;

    try {
        const pFilters = getBinanceSymbolFilters(symbol, baseUrl);
        const pBrackets = getBinanceLeverageBrackets(symbol, baseUrl, keys);
        const pPrice = getBinancePrice(symbol, baseUrl);
        const pBalance = global.sizingMode === "percent" ? getBinanceBalance(baseUrl, keys) : Promise.resolve(0);

        const [filters, brackets, price, balance] = await Promise.all([pFilters, pBrackets, pPrice, pBalance]);

        // SMART LEVERAGE & CAP
        let targetLev = Math.min(global.leverage, brackets[0].initialLeverage);
        let margin = global.sizingMode === "percent" ? balance * (global.sizingValue / 100) : global.sizingValue;
        let notional = margin * targetLev;

        for (const b of brackets) {
            if (notional <= b.notionalCap) {
                targetLev = b.initialLeverage;
                break;
            }
        }

        const finalLev = Math.min(global.leverage, targetLev);
        let qty = calculateQtyPure(global.sizingMode, global.sizingValue, balance, finalLev, price);
        qty = roundToStep(qty, filters.stepSize);

        if (parseFloat(qty) <= 0) return notify("Binance Error", "Qty too small");

        await setBinanceLeverage(symbol, finalLev, baseUrl, keys);

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

        if (tvData.tp || tvData.sl) {
            const closeSide = tvData.side.toUpperCase() === "BUY" ? "SELL" : "BUY";
            const pTPSL = [];
            if (tvData.tp) pTPSL.push(placeBinanceTPSL(symbol, closeSide, qty, tvData.tp, "TAKE_PROFIT_MARKET", baseUrl, keys, filters));
            if (tvData.sl) pTPSL.push(placeBinanceTPSL(symbol, closeSide, qty, tvData.sl, "STOP_MARKET", baseUrl, keys, filters));
            await Promise.all(pTPSL);
        }

    } catch (e) { notify("Binance Fail", e.message); console.error(e); }
}

async function modifyBinance(tvData, keys) {
    const symbol = normalizeSymbol(tvData.symbol);
    const baseUrl = keys.baseUrl;
    try {
        const [filters, posData, ordersData] = await Promise.all([
            getBinanceSymbolFilters(symbol, baseUrl),
            getBinancePosition(symbol, baseUrl, keys),
            getBinanceOpenOrders(symbol, baseUrl, keys)
        ]);

        const pos = Array.isArray(posData) ? posData.find(p => parseFloat(p.positionAmt) !== 0) : posData;
        if (!pos || parseFloat(pos.positionAmt) === 0) return;

        const amt = Math.abs(parseFloat(pos.positionAmt));
        const closeSide = parseFloat(pos.positionAmt) > 0 ? "SELL" : "BUY";

        const promises = [];
        if ("tp" in tvData) {
            const oldTP = ordersData.filter(o => o.type.includes("TAKE_PROFIT"));
            oldTP.forEach(o => promises.push(cancelBinanceOrder(symbol, o.orderId, baseUrl, keys)));
            if (tvData.tp > 0) promises.push(placeBinanceTPSL(symbol, closeSide, amt, tvData.tp, "TAKE_PROFIT_MARKET", baseUrl, keys, filters));
        }
        if ("sl" in tvData) {
            const oldSL = ordersData.filter(o => o.type.includes("STOP"));
            oldSL.forEach(o => promises.push(cancelBinanceOrder(symbol, o.orderId, baseUrl, keys)));
            if (tvData.sl > 0) promises.push(placeBinanceTPSL(symbol, closeSide, amt, tvData.sl, "STOP_MARKET", baseUrl, keys, filters));
        }
        await Promise.all(promises);
        notify("Binance Update", "TP/SL Modified");
    } catch (e) { console.error(e); }
}

async function closeBinance(tvData, keys) {
    const symbol = normalizeSymbol(tvData.symbol);
    try {
        const posData = await getBinancePosition(symbol, keys.baseUrl, keys);
        const pos = Array.isArray(posData) ? posData.find(p => parseFloat(p.positionAmt) !== 0) : posData;
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
// 🟠 BYBIT LOGIC (FIXED)
// =================================================================

async function openBybit(tvData, keys, global) {
    if (!keys.apiKey || !tvData.side) return;
    const symbol = normalizeSymbol(tvData.symbol);
    const baseUrl = keys.baseUrl;

    try {
        const pFilters = getBybitInstrumentInfo(symbol, baseUrl);
        const pPrice = getBybitPrice(symbol, baseUrl);
        const pBalance = global.sizingMode === "percent" ? getBybitBalance(baseUrl, keys) : Promise.resolve(0);

        const [filters, price, balance] = await Promise.all([pFilters, pPrice, pBalance]);

        const maxLev = parseFloat(filters.maxLeverage) || 20;
        const finalLev = Math.min(global.leverage, maxLev);

        let qty = calculateQtyPure(global.sizingMode, global.sizingValue, balance, finalLev, price);
        qty = roundToStep(qty, filters.qtyStep);

        if (parseFloat(qty) <= 0) return notify("Bybit Error", "Qty too small");

        await setBybitLeverage(symbol, finalLev, baseUrl, keys);

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
// 🔐 HELPERS & PURE MATH
// =================================================================

function calculateQtyPure(mode, sizingValue, balance, leverage, price) {
    let margin = sizingValue;
    if (mode === "percent") {
        margin = balance * (sizingValue / 100);
    }
    return (margin * leverage) / price;
}

function normalizeSymbol(raw) {
    if (!raw) return "UNDEFINED";
    let s = raw.split(":")[1] || raw;
    s = s.replace(".P", "").replace("/", "").replace("PERP", "").toUpperCase();
    if (!s.endsWith("USDT") && !s.endsWith("USDC") && !s.endsWith("BUSD")) {
        if (s.endsWith("USD")) s = s.slice(0, -3) + "USDT";
        else s += "USDT";
    }
    const specialMap = {
        "PEPEUSDT": "1000PEPEUSDT", "BONKUSDT": "1000BONKUSDT", "FLOKIUSDT": "1000FLOKIUSDT",
        "SHIBUSDT": "1000SHIBUSDT", "SATSUSDT": "1000SATSUSDT", "RATSUSDT": "1000RATSUSDT",
        "XECUSDT": "1000XECUSDT", "LUNCUSDT": "1000LUNCUSDT", "BTTUSDT": "1000000BTTUSDT"
    };
    if (specialMap[s]) s = specialMap[s];
    return s;
}

// CACHED FILTERS
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

async function getBinanceLeverageBrackets(symbol, url, keys) {
    try {
        const qs = `symbol=${symbol}&timestamp=${Date.now()}`;
        const sig = await signBinance(qs, keys.apiSecret);
        const res = await fetch(`${url}/fapi/v1/leverageBracket?${qs}&signature=${sig}`, { headers: { "X-MBX-APIKEY": keys.apiKey } });
        const data = await res.json();
        return Array.isArray(data) ? data[0].brackets.sort((a, b) => b.initialLeverage - a.initialLeverage) : [{ initialLeverage: 20, notionalCap: 1000000 }];
    } catch (e) { return [{ initialLeverage: 20, notionalCap: 1000000 }]; }
}

async function getBybitInstrumentInfo(symbol, url) {
    if (bybitExchangeInfo[symbol]) return bybitExchangeInfo[symbol];
    try {
        const res = await fetch(`${url}/v5/market/instruments-info?category=linear&symbol=${symbol}`);
        const data = await res.json();
        const info = data.result.list[0];
        const result = { qtyStep: info.lotSizeFilter.qtyStep, priceStep: info.priceFilter.tickSize, maxLeverage: info.leverageFilter.maxLeverage };
        bybitExchangeInfo[symbol] = result;
        return result;
    } catch (e) { return { qtyStep: "0.001", priceStep: "0.01", maxLeverage: "20" }; }
}

// STANDARD UTILS
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
async function getBinancePosition(symbol, url, keys) {
    const qs = `symbol=${symbol}&timestamp=${Date.now()}`;
    const sig = await signBinance(qs, keys.apiSecret);
    const res = await fetch(`${url}/fapi/v2/positionRisk?${qs}&signature=${sig}`, { headers: { "X-MBX-APIKEY": keys.apiKey } });
    return await res.json();
}
async function getBinanceOpenOrders(symbol, url, keys) {
    const qs = `symbol=${symbol}&timestamp=${Date.now()}`;
    const sig = await signBinance(qs, keys.apiSecret);
    const res = await fetch(`${url}/fapi/v1/openOrders?${qs}&signature=${sig}`, { headers: { "X-MBX-APIKEY": keys.apiKey } });
    return await res.json();
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
function notify(title, msg) {
    // if (chrome.notifications) chrome.notifications.create({ type: "basic", iconUrl: "icon.png", title, message: msg });
}