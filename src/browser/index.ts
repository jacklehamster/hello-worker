/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import { enterRoom } from "./signal-room.js";

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


enterRoom({
    room: "test",
    host: location.host,
    getWelcomeNote: async () => {
        return { note: welcomeEl.value };
    },
    getAnswerNote: async () => {
        return { note: "Thank you! 🙏" };
    },
    onOpen: () => {
        statusEl.textContent = "connected";
        logLine("🔗  CONNECTED");
    },
    onClose: () => {
        statusEl.textContent = "closed";
        logLine("⛓️‍💥  DISCONNECTED");
        statusEl.textContent = "closed";
    },
    onError: () => {
        statusEl.textContent = "error";
        logLine("⚠️ ERROR");
    },
    logLine,
});
