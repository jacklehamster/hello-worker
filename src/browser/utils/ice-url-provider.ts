export class IceUrlProvider {
  private sendToServerFunctions = new Array<(command: "request-ice") => void>();
  private icePromiseResolve?: (url: {
    url: string;
    expiration: number;
  }) => void;
  private icePromise?: Promise<{ url: string; expiration: number }>;

  receiveIce(url: string, expiration: number) {
    this.icePromiseResolve?.({ url, expiration });
    this.icePromiseResolve = undefined;
    this.icePromise = undefined;
  }

  addRequester(requester: (command: "request-ice") => void) {
    this.sendToServerFunctions.push(requester);
    return () => {
      this.removeRequester(requester);
    };
  }

  removeRequester(requester: (command: "request-ice") => void) {
    this.sendToServerFunctions.splice(
      this.sendToServerFunctions.indexOf(requester),
      1,
    );
  }

  sendToServer(command: "request-ice") {
    this.sendToServerFunctions[
      Math.floor(this.sendToServerFunctions.length * Math.random())
    ](command);
  }

  async requestIce() {
    if (!this.icePromise) {
      this.icePromise = new Promise<{ url: string; expiration: number }>(
        (resolve) => {
          this.icePromiseResolve = resolve;
          this.sendToServer("request-ice");
        },
      );
    }
    return await this.icePromise;
  }
}
