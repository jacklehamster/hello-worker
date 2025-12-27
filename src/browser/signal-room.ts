export interface IUser<T extends string = string, P = any> {
    info: { peerId: string; userId: string };
    receive(type: T, payload: P): boolean;
}

/**
 * enterRoom connects to the signaling room via WebSocket.
 * 
 * Usage:
 *  const { exitRoom } = enterRoom({
 *      room: "test",
 *      host: location.host,
 *      onOpen: () => { ... },
 *      onClose: () => { ... },
 *      onError: () => { ... },
 *      onPeerJoined: (user) => { ... },
 *      onMessage: (type, payload, fromUser) => { ... },
 * });
 */
export function enterRoom<T extends string, P = any>({
    userId,
    room,
    host,
    onOpen,
    onClose,
    onError,
    logLine,
    onPeerJoined,
    onMessage,
}: {
    userId: string;
    room: string;
    host: string;
    onOpen?: () => void;
    onClose?: () => void;
    onError?: () => void;
    logLine?: (direction: string, obj?: any) => void;
    onPeerJoined?: (user: IUser) => void;
    onMessage?: (type: T, payload: P, from: IUser) => void;
}) {
    const wsUrl = "wss://" + host + "/room/" + room + "?userId=" + encodeURIComponent(userId);
    const ws = new WebSocket(wsUrl);

    let exited = false;
    function send(type: T, to: string, payload: P) {
        if (exited) return false;
        const obj = { type, to, payload };
        ws.send(JSON.stringify(obj));
        logLine?.("👤 ➡️ 🖥️", obj);
        return true;
    }

    function onmessage(e: MessageEvent) {
        let msg;
        try { msg = JSON.parse(e.data); }
        catch { msg = { raw: e.data }; }

        logLine?.("🖥️ ➡️ 👤", msg);

        // Existing client greets newcomers
        if (msg.type === "peer-joined" && msg.peerId && msg.userId) {
            onPeerJoined?.({
                info: { peerId: msg.peerId, userId: msg.userId },
                receive: (type: T, payload: P) => {
                    return send(type, msg.peerId, payload);
                },
            });
            return;
        }
        if (msg.from.peerId && msg.from.userId) {
            onMessage?.(msg.type, msg.payload, {
                info:{ peerId: msg.from.peerId, userId: msg.from.userId },
                receive: (type: T, payload: P) => {
                    return send(type, msg.peerId, payload);
                },
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