import { EventEmitter } from 'events';
import type { IncomingMessage, ClientRequest } from 'http';
import RequestHandlerHelper from '../client-mixins/request-handler.helper';
import { TRequestFullStreamData } from '../client-mixins/request-maker.mixin';
import { ETwitterStreamEvent } from '../types';
import TweetStreamEventCombiner from './TweetStreamEventCombiner';
import TweetStreamParser, { EStreamParserEvent } from './TweetStreamParser';

interface ITweetStreamError {
  type: ETwitterStreamEvent.ConnectionError | ETwitterStreamEvent.TweetParseError
    | ETwitterStreamEvent.ReconnectError | ETwitterStreamEvent.DataError;
  error: any;
}

export interface IConnectTweetStreamParams {
  autoReconnect: boolean;
  autoReconnectRetries: number | 'unlimited';
  /** Check for 'lost connection' status every `keepAliveTimeout` milliseconds. Defaults to 2 minutes (`120000`). */
  keepAliveTimeout: number | 'disable';
}

export class TweetStream<T = any> extends EventEmitter {
  public autoReconnect = false;
  public autoReconnectRetries = 5;
  // 2 minutes without any Twitter signal
  public keepAliveTimeoutMs = 1000 * 120;

  protected retryTimeout?: NodeJS.Timeout;
  protected keepAliveTimeout?: NodeJS.Timeout;
  protected parser = new TweetStreamParser();

  protected req?: ClientRequest;
  protected res?: IncomingMessage;

  constructor(
    protected requestData: TRequestFullStreamData,
    req?: ClientRequest,
    res?: IncomingMessage,
  ) {
    super();

    this.onKeepAliveTimeout = this.onKeepAliveTimeout.bind(this);
    this.initEventsFromParser();

    if (req && res) {
      this.req = req;
      this.res = res;
      this.initEventsFromRequest();
    }
  }

  // Event typings
  on(event: ETwitterStreamEvent.Data, handler: (data: T) => any): this;
  on(event: ETwitterStreamEvent.DataError, handler: (error: any) => any): this;
  on(event: ETwitterStreamEvent.Error, handler: (errorPayload: ITweetStreamError) => any): this;
  on(event: ETwitterStreamEvent.ConnectionLost, handler: () => any): this;
  on(event: ETwitterStreamEvent.ConnectionError, handler: (error: Error) => any): this;
  on(event: ETwitterStreamEvent.TweetParseError, handler: (error: Error) => any): this;
  on(event: ETwitterStreamEvent.ConnectionClosed, handler: () => any): this;
  on(event: ETwitterStreamEvent.DataKeepAlive, handler: () => any): this;
  on(event: ETwitterStreamEvent.ReconnectAttempt, handler: (tries: number) => any): this;
  on(event: ETwitterStreamEvent.ReconnectError, handler: (tries: number) => any): this;
  on(event: ETwitterStreamEvent.ReconnectLimitExceeded, handler: () => any): this;
  on(event: ETwitterStreamEvent.Reconnected, handler: () => any): this;
  on(event: string | symbol, handler: (...args: any[]) => any): this;
  on(event: string | symbol, handler: (...args: any[]) => any) {
    return super.on(event, handler);
  }

  protected initEventsFromRequest() {
    if (!this.req || !this.res) {
      throw new Error('TweetStream error: You cannot init TweetStream without a request and response object.');
    }

    const errorHandler = (err: any) => {
      this.emit(ETwitterStreamEvent.ConnectionError, err);
      this.emit(ETwitterStreamEvent.Error, {
        type: ETwitterStreamEvent.ConnectionError,
        error: err,
      });

      this.onConnectionError();
    };

    this.req.on('error', errorHandler);
    this.res.on('error', errorHandler);
    // Usually, connection should not be closed by Twitter!
    this.res.on('close', () => errorHandler(new Error('Connection closed by Twitter.')));

    this.res.on('data', (chunk: Buffer) => {
      this.resetKeepAliveTimeout();

      if (chunk.toString() === '\r\n') {
        return this.emit(ETwitterStreamEvent.DataKeepAlive);
      }

      this.parser.push(chunk.toString());
    });

    // Starts the keep alive timeout
    this.resetKeepAliveTimeout();
  }

  protected initEventsFromParser() {
    const payloadIsError = this.requestData.payloadIsError;

    this.parser.on(EStreamParserEvent.ParsedData, (eventData: any) => {
      if (payloadIsError && payloadIsError(eventData)) {
        this.emit(ETwitterStreamEvent.DataError, eventData);
        this.emit(ETwitterStreamEvent.Error, { type: ETwitterStreamEvent.DataError, error: eventData });
      }
      else {
        this.emit(ETwitterStreamEvent.Data, eventData);
      }
    });

    this.parser.on(EStreamParserEvent.ParseError, (error: any) => {
      this.emit(ETwitterStreamEvent.TweetParseError, error);
      this.emit(ETwitterStreamEvent.Error, {
        type: ETwitterStreamEvent.TweetParseError,
        error,
      });
    });
  }

  protected resetKeepAliveTimeout() {
    this.unbindKeepAliveTimeout();

    if (this.keepAliveTimeoutMs !== Infinity) {
      this.keepAliveTimeout = setTimeout(this.onKeepAliveTimeout, this.keepAliveTimeoutMs);
    }
  }

  protected onKeepAliveTimeout() {
    this.emit(ETwitterStreamEvent.ConnectionLost);
    this.onConnectionError();
  }

  protected unbindTimeouts() {
    this.unbindRetryTimeout();
    this.unbindKeepAliveTimeout();
  }

  protected unbindKeepAliveTimeout() {
    if (this.keepAliveTimeout) {
      clearTimeout(this.keepAliveTimeout);
      this.keepAliveTimeout = undefined;
    }
  }

  protected unbindRetryTimeout() {
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = undefined;
    }
  }

  protected closeWithoutEmit() {
    this.unbindTimeouts();

    if (this.res) {
      this.res.removeAllListeners();
    }
    if (this.req) {
      this.req.removeAllListeners();
      // Close connection silentely
      this.req.destroy();
    }
  }

  /** Terminate connection to Twitter. */
  close() {
    this.emit(ETwitterStreamEvent.ConnectionClosed);
    this.closeWithoutEmit();
  }

  /** Unbind all listeners, and close connection. */
  destroy() {
    this.removeAllListeners();
    this.close();
  }

  /**
   * Make a new request that creates a new `TweetStream` instance with
   * the same parameters, and bind current listeners to new stream.
   */
  async clone() {
    const newRequest = new RequestHandlerHelper(this.requestData);
    const newStream = await newRequest.makeRequestAsStream();

    // Clone attached listeners
    const listenerNames = this.eventNames();

    for (const listener of listenerNames) {
      const callbacks = this.listeners(listener);

      for (const callback of callbacks) {
        newStream.on(listener, callback as any);
      }
    }

    return newStream;
  }

  /** Start initial stream connection, setup options on current instance and returns itself. */
  async connect(options: Partial<IConnectTweetStreamParams> = {}) {
    if (typeof options.autoReconnect !== 'undefined') {
      this.autoReconnect = options.autoReconnect;
    }
    if (typeof options.autoReconnectRetries !== 'undefined') {
      this.autoReconnectRetries = options.autoReconnectRetries === 'unlimited'
        ? Infinity
        : options.autoReconnectRetries;
    }
    if (typeof options.keepAliveTimeout !== 'undefined') {
      this.keepAliveTimeoutMs = options.keepAliveTimeout === 'disable'
        ? Infinity
        : options.keepAliveTimeout;
    }

    await this.reconnect();
    return this;
  }

  /** Make a new request to (re)connect to Twitter. */
  async reconnect() {
    let initialConnection = true;

    if (this.req) {
      initialConnection = false;

      if (!this.req.destroyed) {
        this.closeWithoutEmit();
      }
    }

    const { req, res } = await new RequestHandlerHelper(this.requestData).makeRequestAndResolveWhenReady();

    this.req = req;
    this.res = res;

    this.emit(initialConnection ? ETwitterStreamEvent.Connected : ETwitterStreamEvent.Reconnected);
    this.parser.reset();
    this.initEventsFromRequest();
  }

  protected async onConnectionError(retries = this.safeReconnectRetries) {
    this.unbindTimeouts();

    // Close the request if necessary
    if (this.req && !this.req.destroyed) {
      this.closeWithoutEmit();
    }

    // Terminate stream by events if necessary (no auto-reconnect or retries exceeded)
    if (!this.autoReconnect) {
      this.emit(ETwitterStreamEvent.ConnectionClosed);
      return;
    }
    if (retries <= 0) {
      this.emit(ETwitterStreamEvent.ReconnectLimitExceeded);
      this.emit(ETwitterStreamEvent.ConnectionClosed);
      return;
    }

    // If all other conditions fails, do a reconnect attempt
    try {
      this.emit(ETwitterStreamEvent.ReconnectAttempt, this.safeReconnectRetries - retries);
      await this.reconnect();
    } catch (e) {
      this.emit(ETwitterStreamEvent.ReconnectError, this.safeReconnectRetries - retries);
      this.emit(ETwitterStreamEvent.Error, {
        type: ETwitterStreamEvent.ReconnectError,
        error: new Error(`Reconnect error - ${this.safeReconnectRetries - retries} attempts made yet.`),
      });

      this.makeAutoReconnectRetry(retries);
    }
  }

  protected makeAutoReconnectRetry(retries: number) {
    const tryOccurence = (this.safeReconnectRetries - retries) + 1;
    const nextRetry = Math.min((tryOccurence ** 2) * 1000, 25000);

    this.retryTimeout = setTimeout(() => {
      this.onConnectionError(retries - 1);
    }, nextRetry);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    const eventCombiner = new TweetStreamEventCombiner(this);

    try {
      while (true) {
        if (!this.req || this.req.aborted) {
          throw new Error('Connection closed');
        }

        if (eventCombiner.hasStack()) {
          yield* eventCombiner.popStack();
        }

        const { type, payload } = await eventCombiner.nextEvent();
        if (type === 'error') {
          throw payload;
        }
      }
    } finally {
      eventCombiner.destroy();
    }
  }

  private get safeReconnectRetries() {
    if (this.autoReconnectRetries === Infinity) {
      // Hack to not produce NaNs
      return 9999999999;
    }
    return this.autoReconnectRetries;
  }
}

export default TweetStream;
