export interface Env {
  ROOM: DurableObjectNamespace;
}

export { Room } from "./room";

const TEST_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Cloudflare WebSocket Test</title>
  <style>
    body { font-family: sans-serif; padding: 20px; }
    #log { background:#111; color:#0f0; padding:10px; height:200px; overflow:auto; }
  </style>
</head>
<body>
  <h1>WebSocket Test</h1>
  <p>Status: <b id="status">connecting…</b></p>

  <input id="msg" placeholder="message" />
  <button id="send">Send</button>

  <pre id="log"></pre>

  <script>
    const status = document.getElementById("status");
    const log = document.getElementById("log");
    const input = document.getElementById("msg");
    const send = document.getElementById("send");

    function write(line) {
      log.textContent += line + "\\n";
      log.scrollTop = log.scrollHeight;
    }

    const wsUrl = "wss://" + location.host + "/room/test";
    write("Connecting to " + wsUrl);

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      status.textContent = "connected";
      write("✓ connected");
    };

    ws.onmessage = (e) => {
      write("← " + e.data);
    };

    ws.onclose = () => {
      status.textContent = "closed";
      write("✕ closed");
    };

    ws.onerror = () => {
      status.textContent = "error";
      write("⚠ error");
    };

    send.onclick = () => {
      if (!input.value) return;
      ws.send(input.value);
      write("→ " + input.value);
      input.value = "";
    };
  </script>
</body>
</html>`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // 👉 If NOT /room/<id>, serve test HTML
    const match = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!match) {
      return new Response(TEST_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // 👉 WebSocket handling
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
