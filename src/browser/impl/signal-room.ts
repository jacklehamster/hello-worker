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
    onPeerJoined(users: IPeer<T, P>[]) : void;
    onPeerLeft(users: {userId: string, peerId: string}[]) : void;
    onMessage(type: T, payload: P, from: IPeer<T, P>) : void;
}): { exitRoom: () => void } {
    const wsUrl = `wss://${host}/room/${appId}/${room}?userId=${encodeURIComponent(userId)}`;
    const ws = new WebSocket(wsUrl);
    const selfUserId = userId;

    const peers = new Map<string, IPeer<T, P>>();
    let exited = false;
    function send(type: T, toPeerId: string, payload: P) {
        if (exited) return false;
        const obj = { type, to: toPeerId, payload };
        ws.send(JSON.stringify(obj));
        logLine?.("👤 ➡️ 🖥️", obj);
        return true;
    }

    function updatePeers(updatedUsers: { peerId: string; userId: string }[]) {
        const joined: IPeer<T,P>[] = [];
        const left: Omit<IPeer<T,P>, "receive">[] = [];
        const updatedPeerSet = new Set<string>();
        updatedUsers.forEach(({ userId, peerId }) => {
            if (userId === selfUserId) return;
            if (!peers.has(peerId)) {
                const newPeer = { userId, peerId, receive: (type: T, payload: P) => send(type, peerId, payload)};
                peers.set(peerId, newPeer);
                joined.push(newPeer);
            }
            updatedPeerSet.add(peerId);
        });
        peers.values().forEach(({ peerId, userId }) => {
            if (!updatedPeerSet.has(peerId)) {
                peers.delete(peerId);
                left.push({ peerId, userId });
            }
        });
        if (joined.length) onPeerJoined(joined);
        if (left.length) onPeerLeft(left);
    }

    function onmessage(e: MessageEvent) {
        let msg: {
            type: T;
            peerId: string;
            userId: string;
            users: { peerId: string, userId: string }[],
            payload: P;
        };
        try { msg = JSON.parse(e.data); }
        catch {
            logLine?.("⚠️ ERROR", { error: "invalid-json" });
            return;
        }

        logLine?.("🖥️ ➡️ 👤", msg);

        // Existing client greets newcomers
        if (msg.type === "peer-joined") {
            updatePeers(msg.users);
            return;
        }
        if (msg.type === "peer-left") {
            updatePeers(msg.users);
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
