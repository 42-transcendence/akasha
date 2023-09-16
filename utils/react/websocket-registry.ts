type HandshakeLike =
  | ArrayBufferLike
  | ArrayBufferView
  | ArrayBufferLike[]
  | ArrayBufferView[]
  | undefined;

export type WebSocketRegisterProps = {
  name: string;
  url: string | URL | (() => string | URL);
  protocols?: string | string[] | undefined;
  handshake?:
    | ((evt: Event) => HandshakeLike | Promise<HandshakeLike>)
    | undefined;
  onClose?: ((evt: CloseEvent) => void) | undefined;
  onError?: ((evt: Event) => void) | undefined;
  onMessage?: ((evt: MessageEvent) => void) | undefined;
  onOpen?: ((evt: Event) => void) | undefined;
};

export const enum SocketStateNumber {
  INITIAL,
  OPEN,
  CLOSED,
  RECONNECTING,
}

export type InitialSocketState = {
  number: SocketStateNumber.INITIAL;
};

export type OpenSocketState = {
  number: SocketStateNumber.OPEN;
};

export type ClosedSocketState = {
  number: SocketStateNumber.CLOSED;
} & ClosedSocketReason;

export type ClosedSocketReason = {
  code: number;
  reason: string;
  wasClean: boolean;
};

export type ReconnectingSocketState = {
  number: SocketStateNumber.RECONNECTING;
};

export type SocketState =
  | InitialSocketState
  | OpenSocketState
  | ClosedSocketState
  | ReconnectingSocketState;

export type WebSocketListenProps = {
  name: string;
  webSocketRef: React.MutableRefObject<WebSocket | undefined>;
  setSocketState: React.Dispatch<React.SetStateAction<SocketState>>;
  setLastMessage: React.Dispatch<React.SetStateAction<ArrayBuffer | undefined>>;
  setLastMessageSync: React.Dispatch<
    React.SetStateAction<ArrayBuffer | undefined>
  >;
  filter: ((value: ArrayBuffer) => boolean) | undefined;
  handleError?: ((ev: Event) => void) | undefined;
  handleClose?: ((result: ClosedSocketReason) => void) | undefined;
};

class WebSocketEntry {
  webSocket: WebSocket | undefined;
  webSocketRef: typeof this.webSocket;
  lastState: SocketState = { number: SocketStateNumber.INITIAL };
}

export class WebSocketRegistry {
  static readonly DEFAULT = new WebSocketRegistry();

  private readonly registry = new Map<string, WebSocketEntry>();
  private readonly listeners = new Map<string, Set<WebSocketListenProps>>();

  register(props: WebSocketRegisterProps): () => void {
    const key = props.name;
    if (key === "") {
      return () => {};
    }
    if (this.registry.has(key)) {
      throw new ReferenceError();
    }
    const value = new WebSocketEntry();
    let ignore = false;

    const connect = () => {
      const url = typeof props.url === "function" ? props.url() : props.url;
      const webSocket = new WebSocket(url, props.protocols);
      webSocket.binaryType = "arraybuffer";

      value.webSocket = webSocket;

      if (props.onClose !== undefined) {
        webSocket.addEventListener("close", props.onClose);
      }

      if (props.onError !== undefined) {
        webSocket.addEventListener("error", props.onError);
      }

      if (props.onMessage !== undefined) {
        webSocket.addEventListener("message", props.onMessage);
      }

      if (props.onOpen !== undefined) {
        webSocket.addEventListener("open", props.onOpen);
      }

      const listeners = this.ensureListenerSet(key);

      webSocket.addEventListener("close", (ev) => {
        value.webSocket = undefined;

        const state: ClosedSocketState = {
          number: SocketStateNumber.CLOSED,
          ...ev,
        };
        value.webSocketRef = undefined;
        value.lastState = state;

        for (const listener of listeners) {
          listener.handleClose?.(ev);
          listener.webSocketRef.current = undefined;
          listener.setSocketState(state);
          listener.setLastMessage(undefined);
        }

        if (!ignore) {
          //TODO: 지수 백오프, AbortSignal
          connect();
        }
      });

      webSocket.addEventListener("error", (ev) => {
        for (const listener of listeners) {
          listener.handleError?.(ev);
        }
      });

      webSocket.addEventListener("message", (ev) => {
        const message = ev.data as ArrayBuffer;

        for (const listener of listeners) {
          if (listener.filter?.(message) ?? true) {
            listener.setLastMessageSync(message);
          }
        }
      });

      webSocket.addEventListener("open", (evForward) => {
        const callback = async (ev: typeof evForward) => {
          if (props.handshake !== undefined) {
            const data: HandshakeLike | Promise<HandshakeLike> =
              props.handshake(ev);
            const sendHandshake = (data: HandshakeLike) => {
              if (data !== undefined) {
                if (Array.isArray(data)) {
                  for (const buffer of data) {
                    webSocket.send(buffer);
                  }
                } else {
                  webSocket.send(data);
                }
              }
            };
            sendHandshake(data instanceof Promise ? await data : data);
          }

          const state: OpenSocketState = {
            number: SocketStateNumber.OPEN,
          };

          value.webSocketRef = webSocket;
          value.lastState = state;

          for (const listener of listeners) {
            listener.webSocketRef.current = webSocket;
            listener.setSocketState(state);
            listener.setLastMessage(undefined);
          }
        };
        callback(evForward).catch((e) => {
          //NOTE: do NOT handle error
          throw e;
        });
      });
    };
    connect();

    this.registry.set(key, value);
    return () => {
      ignore = true;
      this.registry.delete(key);
      value.webSocket?.close();
    };
  }

  listen(props: WebSocketListenProps): () => void {
    const key = props.name;
    const value = this.ensureListenerSet(key);

    if (value.has(props)) {
      throw new ReferenceError();
    }

    const entry = this.registry.get(key);
    if (entry !== undefined) {
      props.webSocketRef.current = entry.webSocketRef;
      props.setSocketState(entry.lastState);
    }

    value.add(props);
    return () => {
      value.delete(props);
    };
  }

  private ensureListenerSet(key: string) {
    const prev = this.listeners.get(key);
    if (prev !== undefined) {
      return prev;
    }

    const value = new Set<WebSocketListenProps>();
    this.listeners.set(key, value);
    return value;
  }
}
