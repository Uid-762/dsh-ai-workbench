/**
 * The Server-Sent Events hub.
 *
 * The stream is a *hint* channel, not the source of truth: every frame either
 * carries a full snapshot or names what changed, and the client's answer to a
 * revision gap is to refetch `/state`. That keeps the two halves honest when a
 * frame is lost, and it means the stream never has to be replayed.
 *
 * Two operational decisions worth stating:
 *
 *   - A slow client is DROPPED, not buffered. `res.write` returns false when the
 *     socket buffer is full; buffering there would grow without bound while the
 *     user has a stalled tab open. Dropping costs one refetch on reconnect.
 *   - A heartbeat comment every 25 s keeps proxies and the Electron network stack
 *     from reaping an idle connection.
 */
import type { ServerResponse } from 'node:http'
import type { ForgeLedger } from '../protocol.ts'
import type { StreamEventPayload } from '../protocol.ts'

/** How often an idle connection gets a comment frame. */
const HEARTBEAT_MS = 25_000

/** Reconnect delay the browser should use, in milliseconds. */
const RETRY_MS = 3000

interface Client {
  res: ServerResponse
  timer: NodeJS.Timeout
}

/** A single SSE stream shared by every open window and panel. */
export class EventHub {
  #clients = new Map<ServerResponse, Client>()
  #unsubscribe: (() => void) | undefined

  /** Subscribe to ledger mutations and forward them as frames. */
  attach(ledger: { subscribe(listener: (file: ForgeLedger) => void): () => void }): void {
    this.#unsubscribe?.()
    this.#unsubscribe = ledger.subscribe((file) => {
      this.broadcast({ kind: 'state', revision: file.revision })
    })
  }

  /** Number of connected clients. Used as the "is anyone listening" signal. */
  get size(): number {
    return this.#clients.size
  }

  /**
   * Adopt a raw HTTP response as an SSE stream.
   *
   * Headers are written before this returns, so the caller must not write again.
   * `x-accel-buffering: no` is what stops a reverse proxy from holding frames
   * until its own buffer fills, which otherwise makes the stream look dead.
   */
  adopt(res: ServerResponse, revision: number): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(`retry: ${RETRY_MS}\n\n`)
    const timer = setInterval(() => {
      // A comment frame: legal SSE, ignored by EventSource, enough to keep the
      // connection warm. Failures are handled by the close listener below.
      try {
        res.write(': ping\n\n')
      } catch {
        this.release(res)
      }
    }, HEARTBEAT_MS)
    timer.unref?.()
    this.#clients.set(res, { res, timer })
    const onClose = (): void => {
      this.release(res)
    }
    res.on('close', onClose)
    res.on('error', onClose)
    this.send(res, { kind: 'hello', revision })
  }

  /** Write one frame. Returns false when the client was dropped. */
  send(res: ServerResponse, payload: StreamEventPayload): boolean {
    const client = this.#clients.get(res)
    if (client === undefined) return false
    const frame = `event: ${payload.kind}\ndata: ${JSON.stringify(payload)}\n\n`
    try {
      const flushed = res.write(frame)
      if (!flushed) {
        // The kernel buffer is full: this client is not keeping up. Dropping it
        // is strictly better than queueing frames it will never read.
        this.release(res)
        return false
      }
      return true
    } catch {
      this.release(res)
      return false
    }
  }

  /** Send one frame to every client, dropping those that fail. */
  broadcast(payload: StreamEventPayload): void {
    for (const res of [...this.#clients.keys()]) {
      this.send(res, payload)
    }
  }

  /** Stop tracking a client and end its response. Safe to call twice. */
  release(res: ServerResponse): void {
    const client = this.#clients.get(res)
    if (client === undefined) return
    this.#clients.delete(res)
    clearInterval(client.timer)
    try {
      res.end()
    } catch {
      // The socket is already gone; nothing to end.
    }
  }

  /** End every stream. Called on plugin disposal so no socket outlives the row. */
  closeAll(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    for (const res of [...this.#clients.keys()]) {
      this.release(res)
    }
  }
}
