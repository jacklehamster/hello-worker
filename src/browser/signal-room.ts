interface IUser<T extends string = string, P = any> {
    receive(type: T, payload: P): void;
}

/**
 * enterRoom connects to the signaling room via WebSocket.
 * 
 * Usage:
 *  const { send, dispose } = enterRoom({
 *      room: "test",
 *      host: location.host,
 *      onOpen: () => { ... },
 *      onClose: () => { ... },
 *      onError: () => { ... },
 *      onPeerJoined: (peerId) => { ... },
 *      onMessage: (type, from, payload) => { ... },
 * });
 */
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
    onPeerJoined?: (user: IUser) => void;
    onMessage?: (type: T, payload: P, from: IUser) => void;
}) {
    const wsUrl = "wss://" + host + "/room/" + room;
    const ws = new WebSocket(wsUrl);

    function send(type: T, to: string, payload: P) {
        const obj = { type, to, payload };
        ws.send(JSON.stringify(obj));
        logLine?.("👤 ➡️ 🖥️", obj);
    }

    class User implements IUser<T, P> {
        constructor(public id: string) {}

        receive(type: T, payload: P) {
            send(type, this.id, payload);
        }
    }

    function onmessage(e: MessageEvent) {
        let msg;
        try { msg = JSON.parse(e.data); }
        catch { msg = { raw: e.data }; }

        logLine?.("🖥️ ➡️ 👤", msg);

        // Existing client greets newcomers
        if (msg.type === "peer-joined" && msg.peerId) {
            onPeerJoined?.(new User(msg.peerId));
            return;
        }
        console.log(msg);
        onMessage?.(msg.type, msg.payload, new User(msg.from));
    };

    ws.addEventListener("message", onmessage);
    if (onOpen) ws.addEventListener("open", onOpen);
    if (onClose) ws.addEventListener("close", onClose);
    if (onError) ws.addEventListener("error", onError);
    return {
        exitRoom: () => {
            ws.removeEventListener("message", onmessage);
            if (onOpen) ws.removeEventListener("open", onOpen);
            if (onClose) ws.removeEventListener("close", onClose);
            if (onError) ws.removeEventListener("error", onError);
            ws.close();
        },
    };
}