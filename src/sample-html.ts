const TEST_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Welcome Note Test</title>
  <style>
    body { font-family: sans-serif; padding: 20px; }
    #log { background:#111; color:#0f0; padding:10px; height:260px; overflow:auto; white-space:pre; }
    textarea { width: 100%; height: 80px; }
    input, button, textarea { font-size: 14px; }
  </style>
</head>
<body>
  <h1>Welcome Note Test</h1>
  <p>Status: <b id="status">connecting…</b></p>

  <h3>Welcome note (sent to newcomers)</h3>
  <textarea id="welcome">Hello 👋 welcome friend!</textarea>

  <h3>Log (one line per network message)</h3>
  <div id="log"></div>

  <script>
    const status = document.getElementById("status");
    const logEl = document.getElementById("log");
    const welcomeEl = document.getElementById("welcome");

    function ts() {
      // HH:MM:SS.mmm (local time)
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, "0");
      const p3 = (n) => String(n).padStart(3, "0");
      return \`\${p2(d.getHours())}:\${p2(d.getMinutes())}:\${p2(d.getSeconds())}.\${p3(d.getMilliseconds())}\`;
    }

    function logLine(direction, obj) {
      logEl.textContent += ts() + "  " + direction + "  " + JSON.stringify(obj) + "\\n";
      logEl.scrollTop = logEl.scrollHeight;
    }

    const wsUrl = "wss://" + location.host + "/room/test";
    const ws = new WebSocket(wsUrl);

    function send(obj) {
      ws.send(JSON.stringify(obj));
      logLine("👤 ➡️ 🖥️", obj);
    }

    ws.onopen = () => {
      status.textContent = "connected";
      logLine("🔗  CONNECTED");
    };
    
    ws.onclose = () => {
      status.textContent = "closed";
      logLine("⛓️‍💥  DISCONNECTED");
    };
    
    ws.onerror = () => {
      status.textContent = "error";
      logLine("⚠️ ERROR");
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); }
      catch { msg = { raw: e.data }; }

      logLine("🖥️ ➡️ 👤", msg);

      // Option 1 behavior: existing members greet newcomers
      if (msg.type === "peer-joined" && msg.peerId) {
        send({
          type: "welcome",
          to: msg.peerId,
          payload: { note: welcomeEl.value },
          t: Date.now(),
        });
      }
    };

    ws.onclose = () => { status.textContent = "closed"; };
    ws.onerror = () => { status.textContent = "error"; };
  </script>
</body>
</html>`;

export default TEST_HTML;

