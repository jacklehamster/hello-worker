/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

const statusEl = document.getElementById("status")!;
const logEl = document.getElementById("log")!;
const welcomeEl = document.getElementById("welcome") as HTMLTextAreaElement;

function ts() {
    // HH:MM:SS.mmm (local time)
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const p3 = (n: number) => String(n).padStart(3, "0");
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
}

function logLine(direction: string, obj?: any) {
    logEl.textContent += ts() + "  " + direction + "  " + (obj ? JSON.stringify(obj) : "") + "\n";
    logEl.scrollTop = logEl.scrollHeight;
}

const wsUrl = "wss://" + location.host + "/room/test";
const ws = new WebSocket(wsUrl);

function send(obj: any) {
    ws.send(JSON.stringify(obj));
    logLine("👤 ➡️ 🖥️", obj);
}

ws.onopen = () => {
    statusEl.textContent = "connected";
    logLine("🔗  CONNECTED");
};

ws.onclose = () => {
    statusEl.textContent = "closed";
    logLine("⛓️‍💥  DISCONNECTED");
};

ws.onerror = () => {
    statusEl.textContent = "error";
    logLine("⚠️ ERROR");
};

ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); }
    catch { msg = { raw: e.data }; }

    logLine("🖥️ ➡️ 👤", msg);

    // Existing client greets newcomers
    if (msg.type === "peer-joined" && msg.peerId) {
    send({
        type: "welcome",
        to: msg.peerId,
        payload: { note: welcomeEl.value },
    });
    return;
    }

    // New client says thanks back to the sender
    if (msg.type === "welcome" && msg.from) {
    send({
        type: "thanks",
        to: msg.from,
        payload: { note: "Thank you! 🙏" },
        t: Date.now(),
    });
    return;
    }
};

ws.onclose = () => { statusEl.textContent = "closed"; };
ws.onerror = () => { statusEl.textContent = "error"; };
