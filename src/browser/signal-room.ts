export function enterRoom({
    room,
    host,
    getWelcomeNote,
    getAnswerNote,
    onOpen,
    onClose,
    onError,
    logLine,
}: {
    room: string;
    host: string;
    getWelcomeNote?: () => Promise<any>;
    getAnswerNote?: (welcomeNote: any) => Promise<any>;
    onOpen?: () => void;
    onClose?: () => void;
    onError?: () => void;
    logLine?: (direction: string, obj?: any) => void;
}) {
    const wsUrl = "wss://" + host + "/room/" + room;
    const ws = new WebSocket(wsUrl);

    function send(obj: any) {
        ws.send(JSON.stringify(obj));
        logLine?.("👤 ➡️ 🖥️", obj);
    }

    ws.onmessage = async (e) => {
        let msg;
        try { msg = JSON.parse(e.data); }
        catch { msg = { raw: e.data }; }

        logLine?.("🖥️ ➡️ 👤", msg);

        // Existing client greets newcomers
        if (msg.type === "peer-joined" && msg.peerId) {
            send({
                type: "welcome",
                to: msg.peerId,
                payload: await getWelcomeNote?.(),
            });
            return;
        }

        // New client says thanks back to the sender
        if (msg.type === "welcome" && msg.from) {
        send({
            type: "thanks",
            to: msg.from,
            payload: await getAnswerNote?.(msg.payload),
        });
        return;
        }
    };

    if (onOpen) ws.addEventListener("open", onOpen);
    if (onClose) ws.addEventListener("close", onClose);
    if (onError) ws.addEventListener("error", onError);
    return () => {
        if (onOpen) ws.removeEventListener("open", onOpen);
        if (onClose) ws.removeEventListener("close", onClose);
        if (onError) ws.removeEventListener("error", onError);
        ws.close();
    }
}