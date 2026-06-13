import type { ServerFrame } from '@notes/shared';

// A tiny WebSocket client for the chat read-path. Cookies ride along on the
// same-origin connection. Liveness is server-driven protocol ping/pong, so
// there are no app-level pings here. Not auto-connected at import: the app
// calls connectChatSocket() after unlock.

type FrameHandler = (frame: ServerFrame) => void;

const RECONNECT_BASE_MS = 500;
const RECONNECT_CAP_MS = 15_000;

let socket: WebSocket | null = null;
let wantConnected = false;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const handlers = new Set<FrameHandler>();
const connectListeners = new Set<() => void>();

function wsUrl(): string {
  return `${location.origin.replace(/^http/, 'ws')}/api/ws`;
}

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (!wantConnected || reconnectTimer !== null) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_CAP_MS);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    open();
  }, delay);
}

function open(): void {
  if (!wantConnected) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    reconnectAttempts = 0;
    for (const fn of connectListeners) fn();
  };

  ws.onmessage = (ev) => {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerFrame;
    } catch {
      return;
    }
    for (const fn of handlers) fn(frame);
  };

  ws.onclose = () => {
    if (socket === ws) socket = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose follows and drives the reconnect; just close defensively.
    try {
      ws.close();
    } catch {
      /* noop */
    }
  };
}

/** Open the chat socket (idempotent) and start delivering frames to onFrame.
 * Auto-reconnects with exponential backoff on close/error. */
export function connectChatSocket(onFrame: FrameHandler): void {
  handlers.add(onFrame);
  wantConnected = true;
  reconnectAttempts = 0;
  clearReconnectTimer();
  open();
}

/** Subscribe an additional frame handler. Returns an unsubscribe fn. */
export function onFrame(handler: FrameHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** Run a callback each time the socket (re)connects, e.g. to backfill. */
export function onConnect(listener: () => void): () => void {
  connectListeners.add(listener);
  return () => connectListeners.delete(listener);
}

/** Close the socket and prevent further reconnects. */
export function disconnectChatSocket(): void {
  wantConnected = false;
  clearReconnectTimer();
  reconnectAttempts = 0;
  handlers.clear();
  connectListeners.clear();
  if (socket) {
    const ws = socket;
    socket = null;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* noop */
    }
  }
}
