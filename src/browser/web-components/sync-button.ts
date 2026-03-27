import { enterWorld } from "../enter-world";

const session = enterWorld({
  worldId: "sync-buttons",
  dataChannelOptions: {
    ordered: false,
  },
  logLine: console.log,
});

session.enterRoom({
  room: "sync-button",
  host: "hello.dobuki.net",
});

export class SyncButton extends HTMLElement {
  static observedAttributes = ["id", "disabled"];

  private shadowButton!: HTMLButtonElement;
  private slotEl!: HTMLSlotElement;

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.onMessage = this.onMessage.bind(this);
    this.onClickButton = this.onClickButton.bind(this);

    this.shadowRoot!.innerHTML = `
      <style>
        :host {
          display: inline-block;
        }

        button {
          font: inherit;
          color: inherit;
          background: var(--sync-button-bg, ButtonFace);
          border: var(--sync-button-border, 1px solid ButtonBorder);
          padding: var(--sync-button-padding, 0.375rem 0.75rem);
          border-radius: var(--sync-button-radius, 0.375rem);
          cursor: pointer;
        }

        button:disabled {
          cursor: not-allowed;
          opacity: 0.6;
        }
      </style>
      <button part="button" type="button">
        <slot></slot>
      </button>
    `;

    this.shadowButton = this.shadowRoot!.querySelector("button")!;
    this.slotEl = this.shadowRoot!.querySelector("slot")!;
  }

  connectedCallback() {
    session.addMessageListener(this.onMessage);
    this.shadowButton.addEventListener("click", this.onClickButton);
    this.syncToInnerButton();
    this.upgradeProperty("disabled");
  }

  disconnectedCallback() {
    session.removeMessageListener(this.onMessage);
    this.shadowButton.removeEventListener("click", this.onClickButton);
  }

  attributeChangedCallback(
    _name: string,
    _oldValue: string | null,
    _newValue: string | null,
  ) {
    this.syncToInnerButton();
  }

  get disabled(): boolean {
    return this.hasAttribute("disabled");
  }

  set disabled(value: boolean) {
    this.toggleAttribute("disabled", Boolean(value));
  }

  focus(options?: FocusOptions) {
    this.shadowButton.focus(options);
  }

  click() {
    this.shadowButton.click();
  }

  private syncToInnerButton() {
    this.shadowButton.disabled = this.disabled;

    if (this.id) {
      this.shadowButton.id = this.id;
    } else {
      this.shadowButton.removeAttribute("id");
    }

    this.setAttribute("role", "button");
    this.setAttribute("tabindex", this.disabled ? "-1" : "0");
    this.setAttribute("aria-disabled", String(this.disabled));
  }

  private upgradeProperty(prop: "disabled") {
    if (Object.prototype.hasOwnProperty.call(this, prop)) {
      const value = (this as any)[prop];
      delete (this as any)[prop];
      (this as any)[prop] = value;
    }
  }

  private onMessage(data: string | ArrayBufferLike) {
    try {
      const { action, id } = JSON.parse(String(data));
      if (action === "click" && this.id === id) {
        this.shadowButton.removeEventListener("click", this.onClickButton);
        this.shadowButton.click();
        this.shadowButton.addEventListener("click", this.onClickButton);
      }
    } catch {
      // ignore non-json
    }
  }

  private onClickButton() {
    session.send(JSON.stringify({ action: "click", id: this.id }));
  }
}

customElements.define("sync-button", SyncButton);
