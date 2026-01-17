// 🛡️ SINGLETON GUARD: Prevents double-injection
if (!window.tvBridgeActive) {
    window.tvBridgeActive = true;

    const originalFetch = window.fetch;

    window.fetch = async (...args) => {
        const [resource, config] = args;

        // --- 1. FAST LISTENERS (Request Body) ---
        if (typeof resource === "string") {

            // OPEN TRADE
            if (resource.includes("/trading/place/")) {
                try {
                    const payload = JSON.parse(config.body);
                    console.log("🚀 TV Bridge: OPEN", payload);
                    document.dispatchEvent(new CustomEvent("TV_TRADE_EXECUTED", {
                        detail: { type: "TV_TRADE_EXECUTED", action: "OPEN", data: payload }
                    }));
                } catch (e) { }
            }

            // CLOSE TRADE
            if (resource.includes("/trading/close_position/") || resource.includes("/trading/exit_position/")) {
                try {
                    const payload = config.body ? JSON.parse(config.body) : {};
                    console.log("🛑 TV Bridge: CLOSE", payload);
                    document.dispatchEvent(new CustomEvent("TV_TRADE_EXECUTED", {
                        detail: { type: "TV_TRADE_EXECUTED", action: "CLOSE", data: payload }
                    }));
                } catch (e) { }
            }

            // MODIFY ACTIVE POSITION (TP/SL on open trade)
            if (resource.includes("/trading/modify_position/")) {
                try {
                    const payload = JSON.parse(config.body);
                    console.log("📝 TV Bridge: MODIFY POS", payload);
                    document.dispatchEvent(new CustomEvent("TV_TRADE_EXECUTED", {
                        detail: { type: "TV_TRADE_EXECUTED", action: "MODIFY_POSITION", data: payload }
                    }));
                } catch (e) { }
            }

            // 🆕 EDIT PENDING ORDER (Limit Order Change)
            if (resource.includes("/trading/modify/") && !resource.includes("modify_position")) {
                try {
                    const payload = JSON.parse(config.body);
                    console.log("✏️ TV Bridge: EDIT ORDER", payload);
                    document.dispatchEvent(new CustomEvent("TV_TRADE_EXECUTED", {
                        detail: { type: "TV_TRADE_EXECUTED", action: "EDIT", data: payload }
                    }));
                } catch (e) { }
            }
        }

        // --- 2. SLOW LISTENERS (Response Body) ---
        const response = await originalFetch(resource, config);

        // CANCEL
        if (typeof resource === "string" && resource.includes("/trading/cancel/")) {
            try {
                const clone = response.clone();
                const data = await clone.json();
                console.log("🚫 TV Bridge: CANCEL", data);
                document.dispatchEvent(new CustomEvent("TV_TRADE_EXECUTED", {
                    detail: { type: "TV_TRADE_EXECUTED", action: "CANCEL", data: data }
                }));
            } catch (e) { }
        }

        return response;
    };
}