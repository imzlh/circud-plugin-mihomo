export class SseHub {
  constructor() {
    this.sessions = new Set();
    this.sequence = 1;
  }

  accept(event) {
    const session = event.acceptSse({
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
    if (!session) return null;
    this.sessions.add(session);
    session.onclose = () => this.sessions.delete(session);
    session.send(formatSse("ready", { sequence: this.sequence++ }));
    return session;
  }

  publish(event) {
    const record = formatSse(event.type, {
      sequence: this.sequence++,
      timestamp: event.timestamp,
      data: event.data,
    });
    for (const session of [...this.sessions]) {
      if (!session.send(record)) this.sessions.delete(session);
    }
  }

  close() {
    for (const session of [...this.sessions]) session.close();
    this.sessions.clear();
  }
}

export function formatSse(type, data) {
  const safeType = String(type).replace(/[^A-Za-z0-9_.-]/g, "_");
  return `event: ${safeType}\ndata: ${JSON.stringify(data)}\n\n`;
}
