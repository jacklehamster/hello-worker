import { enterWorld } from "../enter-world";

const session = enterWorld({
  worldId: "sync-buttons",
  workerUrl: new URL("../signal/signal-room.worker.js", import.meta.url),
  dataChannelOptions: {
    ordered: false, //  not ordered, but goes faster
  },
  logLine: console.log,
});
session.enterRoom({
  room: "sync-button",
  host: location.host,
});

export class SyncButton extends HTMLElement {
  static observedAttributes = ["id", "disabled"];
  private shadowButton?: HTMLButtonElement;

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.onMessage = this.onMessage.bind(this);
    this.onClickButton = this.onClickButton.bind(this);
  }

  connectedCallback() {
    session.addMessageListener(this.onMessage);

    this.render();
    this.hookSync();
  }

  disconnectedCallback() {
    session.removeMessageListener(this.onMessage);
  }

  private onMessage(data: string | ArrayBufferLike) {
    try {
      const { action } = JSON.parse(String(data));
      if (action === "click") {
        this.unhokSync();
        this.shadowButton?.click();
        this.hookSync();
      }
    } catch {
      // ignore non-json
    }
  }

  attributeChangedCallback(
    name: string,
    oldValue: string | null,
    newValue: string | null,
  ) {
    this.render();
  }

  hookSync() {
    this.shadowButton?.addEventListener("click", this.onClickButton);
  }

  unhokSync() {
    this.shadowButton?.removeEventListener("click", this.onClickButton);
  }

  private onClickButton() {
    session?.send(JSON.stringify({ action: "click" }));
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
    this.shadowButton = button;
  }
}
customElements.define("sync-button", SyncButton);
