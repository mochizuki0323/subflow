import WebSocket from 'ws';
import { EventEmitter } from 'events';

export class WsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shutdownRequested = false;

  constructor(url: string) {
    super();
    this.url = url;
  }

  connect(): void {
    if (this.shutdownRequested || this.ws) return;

    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      console.log('WebSocket connected to backend');
      this.emit('connected');

      // Request initial source list
      this.send({ type: 'list_sources' });
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        const { type, data: payload } = msg;
        this.emit(type, payload);
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    });

    this.ws.on('close', () => {
      console.log('WebSocket disconnected');
      this.ws = null;
      this.emit('disconnected');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      console.error('WebSocket error:', err.message);
      this.ws?.close();
      this.ws = null;
      this.scheduleReconnect();
    });
  }

  /** @returns false when the socket was not open, i.e. the message was dropped. */
  send(msg: object): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  /** Stop reconnect loop permanently (app exit). Unlike disconnect(), used for config restart still reconnects. */
  shutdown(): void {
    this.shutdownRequested = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.shutdownRequested || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      console.log('Attempting WebSocket reconnect...');
      this.connect();
    }, 2000);
  }
}
