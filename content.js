console.log("✅ content.js loaded");

// Inject injected.js
const script = document.createElement("script");
script.src = chrome.runtime.getURL("injected.js");
script.onload = () => script.remove();
(document.head || document.documentElement).appendChild(script);

// Listen for trades from injected.js
document.addEventListener("TV_TRADE_EXECUTED", (event) => {
    console.log("📩 content.js received trade:", event.detail);
    chrome.runtime.sendMessage(event.detail);
});
