/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import { enterRoom } from "../signal-room.js";
import { enterWorld } from "../enter-world.js";

const statusEl = document.getElementById("status")!;
const logEl = document.getElementById("log")!;
const welcomeEl = document.getElementById("welcome") as HTMLInputElement;

function ts() {
  // HH:MM:SS.mmm (local time)
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const p3 = (n: number) => String(n).padStart(3, "0");
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(
    d.getMilliseconds(),
  )}`;
}

function logLine(direction: string, obj?: any) {
  logEl.textContent +=
    ts() + "  " + direction + "  " + (obj ? JSON.stringify(obj) : "") + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

export function clearLog() {
  logEl.textContent = "";
}

export function testWelcome() {
  const { exitRoom } = enterRoom({
    userId: crypto.randomUUID(),
    worldId: "signal-test",
    room: "test",
    host: location.host,
    autoRejoin: true,
    onOpen: () => {
      statusEl.textContent = "🟢 connected";
      logLine("🔗  CONNECTED");
    },
    onClose: (event) => {
      statusEl.textContent = "🔴 closed";
      logLine("⛓️‍💥  DISCONNECTED", event);
    },
    onError: () => {
      statusEl.textContent = "🔴 error";
      logLine("⚠️ ERROR");
    },
    onPeerJoined: (users) => {
      users.forEach((user) =>
        user.receive("welcome", { note: welcomeEl.value }),
      );
    },
    onPeerLeft: (info) => {
      logLine("👤 LEFT", info);
    },
    onMessage: (type, payload, user) => {
      if (type === "welcome") {
        user.receive("thanks", { note: "Thank you! 🙏" });
      }
    },
    logLine,
    workerUrl: new URL("../signal-room.worker.js", import.meta.url),
  });
  return () => {
    statusEl.textContent = "🔴 closed";
    exitRoom();
  };
}

export function testWebRTC(websocketBroadcast: boolean) {
  function setEmojiPos01(x01: number, y01: number) {
    const r = stageEl!.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, x01)) * r.width;
    const y = Math.max(0, Math.min(1, y01)) * r.height;
    emojiEl!.style.left = `${x}px`;
    emojiEl!.style.top = `${y}px`;
  }

  // --- start WebRTC mesh using YOUR joinWebRTCRoom ---
  statusEl.textContent = "🟡 connecting";
  logLine("💬", { event: "start-webrtc-test" });

  const session = enterWorld({
    logLine,
    worldId: websocketBroadcast ? "broadcast-test" : "webRTC-test",
    workerUrl: new URL("../signal-room.worker.js", import.meta.url),
    dataChannelOptions: {
      ordered: false,
    },
  });

  // --- create a stage + emoji (if not already in HTML) ---
  let stageEl = document.getElementById("stage") as HTMLDivElement | null;
  if (!stageEl) {
    stageEl = document.createElement("div");
    stageEl.id = "stage";
    stageEl.style.position = "relative";
    stageEl.style.width = "100%";
    stageEl.style.height = "280px";
    stageEl.style.border = "1px solid #333";
    stageEl.style.borderRadius = "8px";
    stageEl.style.margin = "12px 0";
    stageEl.style.userSelect = "none";
    stageEl.style.touchAction = "none";
    document.body.insertBefore(stageEl, welcomeEl);
  }
  welcomeEl.classList.add("hidden");

  let emojiEl = document.getElementById("emoji") as HTMLDivElement | null;
  if (!emojiEl) {
    emojiEl = document.createElement("div");
    emojiEl.id = "emoji";
    emojiEl.textContent = "🦊";
    emojiEl.style.position = "absolute";
    emojiEl.style.left = "0px";
    emojiEl.style.top = "0px";
    emojiEl.style.transform = "translate(-50%, -50%)";
    emojiEl.style.fontSize = "36px";
    emojiEl.style.pointerEvents = "none";
    stageEl.appendChild(emojiEl);
  }

  let usersEl = document.getElementById("users") as HTMLDivElement | null;
  if (!usersEl) {
    usersEl = document.createElement("div");
    usersEl.id = "users";
    usersEl.textContent = `Users: ${session.getUsers().length + 1}`;
    usersEl.style.fontSize = "12px";
    usersEl.style.pointerEvents = "none";
    stageEl.appendChild(usersEl);
  }

  session
    .enterRoom({
      room: "test",
      host: location.host,
    })
    .then(() => {
      statusEl.textContent = "🟢 connected";
    });
  session.addMessageListener((data, from) => {
    console.log(data, from);
    try {
      const { x, y } = JSON.parse(String(data));
      if (typeof x === "number" && typeof y === "number") {
        setEmojiPos01(x, y);
      }
    } catch {
      // ignore non-json
    }
  });
  session.addUserListener((_userId, _action, users) => {
    usersEl.textContent = `Users: ${users.length + 1}`;
  });

  // --- send mouse position over all open data channels ---
  let lastSent = 0;
  function broadcastMove(x01: number, y01: number) {
    const now = performance.now();
    if (now - lastSent < 16) return; // ~60Hz throttle
    lastSent = now;

    const msg = JSON.stringify({ x: x01, y: y01 });

    if (websocketBroadcast) {
      session.broadcast(msg);
    } else {
      session.send(msg);
    }
  }

  function onPointerMove(ev: PointerEvent) {
    const r = stageEl!.getBoundingClientRect();
    const x01 = (ev.clientX - r.left) / r.width;
    const y01 = (ev.clientY - r.top) / r.height;

    // move locally too (feels instant)
    setEmojiPos01(x01, y01);

    // broadcast to peers via datachannel
    broadcastMove(x01, y01);
  }

  stageEl.addEventListener("pointermove", onPointerMove);

  // return cleanup function (same pattern as testWelcome)
  return () => {
    statusEl.textContent = "🔴 closed";
    stageEl!.removeEventListener("pointermove", onPointerMove);
    stageEl!.remove();
    welcomeEl.classList.remove("hidden");
    session.end();
    logLine("💬", { event: "stop-webrtc-test" });
  };
}
