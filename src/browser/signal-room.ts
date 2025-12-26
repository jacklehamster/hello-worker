export function enterRoom<T extends string, P = any>({
    room,
    host,
    onOpen,
    onClose,
    onError,
    logLine,
    onPeerJoined,
    onMessage,
}: {
    room: string;
    host: string;
    onOpen?: () => void;
    onClose?: () => void;
    onError?: () => void;
    logLine?: (direction: string, obj?: any) => void;
    onPeerJoined?: (peerId: string) => void;
    onMessage?: (type: T, from: string, payload: P) => void;
}) {
    const wsUrl = "wss://" + host + "/room/" + room;
    const ws = new WebSocket(wsUrl);

    function send(type: T, to: string, payload: P) {
        const obj = { type, to, payload };
        ws.send(JSON.stringify(obj));
        logLine?.("👤 ➡️ 🖥️", obj);
    }

    function onmessage(e: MessageEvent) {
        let msg;
        try { msg = JSON.parse(e.data); }
        catch { msg = { raw: e.data }; }

        logLine?.("🖥️ ➡️ 👤", msg);

        // Existing client greets newcomers
        if (msg.type === "peer-joined" && msg.peerId) {
            onPeerJoined?.(msg.peerId);
            return;
        }
        console.log(msg);
        onMessage?.(msg.type, msg.from, msg.payload);
    };

    ws.addEventListener("message", onmessage);
    if (onOpen) ws.addEventListener("open", onOpen);
    if (onClose) ws.addEventListener("close", onClose);
    if (onError) ws.addEventListener("error", onError);
    return {
        send,
        dispose: () => {
            ws.removeEventListener("message", onmessage);
            if (onOpen) ws.removeEventListener("open", onOpen);
            if (onClose) ws.removeEventListener("close", onClose);
            if (onError) ws.removeEventListener("error", onError);
            ws.close();
        },
    };
}