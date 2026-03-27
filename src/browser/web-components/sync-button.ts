import { enterWorld } from "../enter-world";

const session = enterWorld({
  worldId: "sync-buttons",
  workerUrl: new URL("../signal/signal-room.worker.js", import.meta.url),
  dataChannelOptions: {
    ordered: false, //  not ordered, but goes faster
  },
  logLine: console.log,
});

export class SyncButton extends HTMLElement {
  static observedAttributes = ["id", "disabled"];
  private shadowButton?: HTMLButtonElement;
  private uuid = crypto.randomUUID();

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    session.enterRoom({
      room: "sync-button",
      host: location.host,
    });
    session.addMessageListener((data) => {
      console.log("Got message", data);
      try {
        const { action, uuid } = JSON.parse(String(data));
        if (uuid === this.uuid) return;
        if (action === "click") {
          this.shadowButton?.click();
        }
      } catch {
        // ignore non-json
      }
    });

    this.render();
  }

  attributeChangedCallback(
    name: string,
    oldValue: string | null,
    newValue: string | null,
  ) {
    this.render();
  }

  render() {
    const disabled = this.hasAttribute("disabled");

    this.shadowRoot!.innerHTML = "";
    const label = this.textContent?.trim() ?? "";
    const button = this.shadowRoot!.appendChild(
      document.createElement("button"),
    );
    button.disabled = disabled;
    button.textContent = label;
    button.addEventListener("click", () => {
      console.log("session sending message", {
        uuid: this.uuid,
        action: "click",
      });
      session?.send(JSON.stringify({ uuid: this.uuid, action: "click" }));
    });
    this.shadowButton = button;
  }
}
customElements.define("sync-button", SyncButton);
