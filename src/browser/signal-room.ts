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
    onPeerLeft,
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
    onPeerLeft?: (info: IUser["info"]) => void;
    onMessage?: (type: T, payload: P, from: IUser) => void;
}) {
    const wsUrl = "wss://" + host + "/room/" + room + "?userId=" + encodeURIComponent(userId);
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
        let msg;
        try { msg = JSON.parse(e.data); }
        catch { msg = { raw: e.data }; }

        logLine?.("🖥️ ➡️ 👤", msg);

        // Existing client greets newcomers
        if (msg.type === "peer-joined" && msg.peerId && msg.userId) {
            const { userId, peerId } = msg;
            onPeerJoined?.({
                info: { peerId, userId },
                receive: (type: T, payload: P) => {
                    return send(type, peerId, payload);
                },
            });
            return;
        }
        if (msg.type === "peer-left" && msg.peerId && msg.userId) {
            const { userId, peerId } = msg;
            onPeerLeft?.({ peerId, userId });
            return;
        }
        if (msg.from.peerId && msg.from.userId) {
            const { userId, peerId } = msg.from;
            onMessage?.(msg.type, msg.payload, {
                info: { peerId, userId },
                receive: (type: T, payload: P) => {
                    return send(type, peerId, payload);
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