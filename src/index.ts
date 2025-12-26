export interface Env {
  ROOM: DurableObjectNamespace;
}

export { Room } from "./room";

const TEST_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Welcome Note Test</title>
  <style>
    body { font-family: sans-serif; padding: 20px; }
    #log { background:#111; color:#0f0; padding:10px; height:260px; overflow:auto; white-space:pre-wrap; }
    textarea { width: 100%; height: 80px; }
    input, button, textarea { font-size: 14px; }
  </style>
</head>
<body>
  <h1>Welcome Note Test</h1>
  <p>Status: <b id="status">connecting…</b></p>
  <p>Your peerId: <code id="me">?</code></p>

  <h3>Welcome note (sent to newcomers)</h3>
  <textarea id="welcome">Hello 👋 welcome!</textarea>

  <h3>Log</h3>
  <div id="log"></div>

  <script>
    const status = document.getElementById("status");
    const meEl = document.getElementById("me");
    const logEl = document.getElementById("log");
    const welcomeEl = document.getElementById("welcome");

    function log(obj) {
      const line = (typeof obj === "string") ? obj : JSON.stringify(obj, null, 2);
      logEl.textContent += line + "\\n";
      logEl.scrollTop = logEl.scrollHeight;
    }

    const wsUrl = "wss://" + location.host + "/room/test";
    log("Connecting to " + wsUrl);

    const ws = new WebSocket(wsUrl);
    let myPeerId = null;

    ws.onopen = () => {
      status.textContent = "connected";
      log({ event: "ws-open" });

      // optional explicit join message (server already knows you're connected)
      ws.send(JSON.stringify({ type: "join", t: Date.now() }));
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { msg = { raw: e.data }; }

      log({ event: "ws-message", msg });

      if (msg.type === "joined") {
        myPeerId = msg.peerId;
        meEl.textContent = myPeerId;
        return;
      }

      if (msg.type === "peer-joined") {
        const newPeerId = msg.peerId;
        const note = welcomeEl.value;

        // Send targeted welcome to the new peer
        ws.send(JSON.stringify({
          type: "welcome",
          to: newPeerId,
          payload: { note },
          t: Date.now()
        }));

        log({ event: "sent-welcome", to: newPeerId, note });
        return;
      }

      if (msg.type === "welcome") {
        // Display welcome received
        log({ event: "got-welcome", from: msg.from, payload: msg.payload });
        return;
      }
    };

    ws.onclose = () => {
      status.textContent = "closed";
      log({ event: "ws-close" });
    };

    ws.onerror = () => {
      status.textContent = "error";
      log({ event: "ws-error" });
    };
  </script>
</body>
</html>`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // If NOT /room/<id>, serve test HTML
    const match = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!match) {
      return new Response(TEST_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // WebSocket upgrade required
    const upgrade = req.headers.get("Upgrade");
    if (upgrade?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const roomId = decodeURIComponent(match[1]);
    const id = env.ROOM.idFromName(roomId);
    const stub = env.ROOM.get(id);

    return stub.fetch(req);
  },
};
