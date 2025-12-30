export interface IPeer<T extends string = string, P = any> {
    userId: string;
    peerId: string;
    receive(type: T, payload: P): boolean;
}

/**
 * enterRoom connects to the signaling room via WebSocket.
 */
export function enterRoom<T extends string, P = any>({
    userId,
    appId,
    room,
    host,
    onOpen,
    onClose,
    onError,
    logLine,
    onPeerJoined,
    onPeerLeft,
    onMessage,
}: {
    userId: string;
    appId: string;
    room: string;
    host: string;
    onOpen?: () => void;
    onClose?: () => void;
    onError?: () => void;
    logLine?: (direction: string, obj?: any) => void;
    onPeerJoined(user: IPeer<T, P>) : void;
    onPeerLeft(userId: IPeer["userId"], peerId: IPeer["peerId"]) : void;
    onMessage(type: T, payload: P, from: IPeer<T, P>) : void;
}): { exitRoom: () => void } {
    const wsUrl = `wss://${host}/room/${appId}/${room}?userId=${encodeURIComponent(userId)}`;
    const ws = new WebSocket(wsUrl);

    let exited = false;
    function send(type: T, toPeerId: string, payload: P) {
        if (exited) return false;
        const obj = { type, to: toPeerId, payload };
        ws.send(JSON.stringify(obj));
        logLine?.("👤 ➡️ 🖥️", obj);
        return true;
    }

    function onmessage(e: MessageEvent) {
        let msg: {
            type: T;
            peerId: string;
            userId: string;
            payload: P;
        };
        try { msg = JSON.parse(e.data); }
        catch {
            logLine?.("⚠️ ERROR", { error: "invalid-json" });
            return;
        }

        logLine?.("🖥️ ➡️ 👤", msg);

        // Existing client greets newcomers
        if (msg.type === "peer-joined" && msg.peerId && msg.userId) {
            const { userId, peerId } = msg;
            onPeerJoined({
                userId,
                peerId,
                receive: (type: T, payload: P) => send(type, peerId, payload),
            });
            return;
        }
        if (msg.type === "peer-left" && msg.peerId && msg.userId) {
            const { userId, peerId } = msg;
            onPeerLeft(userId, peerId);
            return;
        }
        if (msg.peerId && msg.userId) {
            const { userId, peerId } = msg;
            onMessage(msg.type, msg.payload, {
                userId,
                peerId,
                receive: (type: T, payload: P) => send(type, peerId, payload),
            });
        }
    };

    ws.addEventListener("message", onmessage);
    if (onOpen) ws.addEventListener("open", onOpen);
    if (onClose) ws.addEventListener("close", onClose);
    if (onError) ws.addEventListener("error", onError);
    return {
        exitRoom: () => {
            exited = true;
            ws.close();
            ws.removeEventListener("message", onmessage);
            if (onOpen) ws.removeEventListener("open", onOpen);
            if (onClose) ws.removeEventListener("close", onClose);
            if (onError) ws.removeEventListener("error", onError);
        },
    };
}
