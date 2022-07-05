import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventEmitter } from 'events';
import { hostname } from 'os';
import { AwaitableSender, Connection, ConnectionEvents, Container, EventContext, Receiver, ReceiverEvents, SenderEvents } from 'rhea-promise';

import { AMQP_CONNECTION_DISCONNECTED, AMQP_CONNECTION_RECONNECT } from '../constants';
import { AMQPModuleOptions, CreateReceiverOptions, CreateSenderOptions } from '../interfaces';
import { ErrorMessage, getConnectionToken, getLogger, parseURL } from '../utils';

@Injectable()
export class AMQPService {
  private static readonly logger = getLogger();
  /**
   * Event emitter for AMQP to show what is happening with the created connection.
   */
  public static readonly eventEmitter: EventEmitter = new EventEmitter();

  constructor(private readonly moduleRef: ModuleRef) {}

  /**
   * @param options - module options
   * @returns connection
   */
  public static async createConnection(options: AMQPModuleOptions): Promise<Connection> {
    const connectionToken = getConnectionToken(options);
    this.logger.silly(`Connection creating: ${connectionToken}`);
    if (!options) {
      throw new Error(`Invalid connection options: ${connectionToken}`);
    }
    const { connectionUri, connectionOptions } = options;
    const container = new Container({
      id: `${connectionToken}:${hostname()}:${new Date().getTime()}`.toLowerCase(),
    });
    const connection = container.createConnection({
      ...(!!connectionUri ? parseURL(connectionUri) : {}),
      ...connectionOptions,
    });
    connection.on(ConnectionEvents.connectionOpen, (context: EventContext) => {
      this.logger.silly(`Connection opened: ${connectionToken}`, context.connection.id);
    });
    connection.on(ConnectionEvents.connectionError, (context: EventContext) => {
      const error = [`Connection error: ${connectionToken}`, ErrorMessage.fromContext(context)];
      this.logger.error(...error.filter(e => e));
    });
    connection.on(ConnectionEvents.disconnected, (context: EventContext) => {
      const error = [`Connection closed by peer: ${connectionToken}`, ErrorMessage.fromContext(context)];
      this.logger.warn(...error.filter(e => e));
      const emitted = AMQPService.eventEmitter.emit(AMQP_CONNECTION_DISCONNECTED);
      if (!emitted) {
        this.logger.warn('disconnect event not emitted');
      }
    });
    connection.on(ConnectionEvents.connectionClose, (context: EventContext) => {
      const error = `Connection closed: ${connectionToken}`;
      if (ErrorMessage.fromContext(context)) {
        this.logger.error(error);
      } else {
        this.logger.warn(error);
      }
      const timeoutHandler = setTimeout(async () => {
        (context.connection as any)._connection.dispatch(ConnectionEvents.disconnected, void 0);
        await context.connection
          .open()
          .then(() => {
            this.logger.silly('connection successfully reopened');
            const emitted = AMQPService.eventEmitter.emit(AMQP_CONNECTION_RECONNECT);
            if (!emitted) {
              this.logger.warn('reconnect event not emitted');
            }
          })
          .catch(error => {
            this.logger.error(`reopening connection failed with error: ${error.message}`, error);
          });
        clearTimeout(timeoutHandler);
      }, 1000);
    });
    try {
      await connection.open();
    } catch (err) {
      const errorMessage = ErrorMessage.fromError(err);
      this.logger.error(`Connection open failed: ${connectionToken}`, errorMessage);
      let retry = 0;
      do {
        this.logger.silly(`reopening connection...`);
        retry++;
        await new Promise(resolve => setTimeout(resolve, options.connectionOptions?.initial_reconnect_delay ?? 3000));
        try {
          await connection.open();
          if (connection.isOpen()) {
            AMQPService.eventEmitter.emit(AMQP_CONNECTION_RECONNECT);
            return;
          }
        } catch (err) {
          const errorMessage = ErrorMessage.fromError(err);
          this.logger.error(`Connection reopen failed: ${connectionToken}`, errorMessage);
        }
      } while (retry < (options.connectionOptions?.reconnect_limit ?? 3) && !connection.isOpen());
    }
    return connection;
  }

  /**
   * @param options - create sender options
   * @returns sender
   */
  public async createSender(options: CreateSenderOptions): Promise<AwaitableSender> {
    const { connectionName, senderOptions } = options;
    const connectionToken = getConnectionToken(connectionName);
    const connection = this.moduleRef.get<Connection>(connectionToken, { strict: false });
    const sender = await connection.createAwaitableSender(senderOptions);
    sender.on(SenderEvents.senderOpen, (context: EventContext) => {
      AMQPService.logger.silly(`Sender opened: ${context?.sender?.name}`);
    });
    sender.on(SenderEvents.senderClose, (context: EventContext) => {
      AMQPService.logger.warn(`Sender closed: ${context?.sender?.name}`);
    });
    sender.on(SenderEvents.senderError, (context: EventContext) => {
      const errorMessage = ErrorMessage.fromSender(context);
      AMQPService.logger.error(`Sender error: ${context?.sender?.name}`, {
        error: errorMessage,
      });
    });
    sender.on(SenderEvents.senderDraining, (context: EventContext) => {
      const { name } = context?.sender;
      AMQPService.logger.silly(`Sender requested to drain its credits by remote peer: ${name}`);
    });
    return sender;
  }

  public async createReceiver(options: CreateReceiverOptions): Promise<Receiver> {
    const { connectionToken, credits, receiverOptions } = options;
    const connection = this.moduleRef.get<Connection>(connectionToken, { strict: false });
    const receiver = await connection.createReceiver(receiverOptions);
    receiver.addCredit(credits);
    receiver.on(ReceiverEvents.receiverOpen, (context: EventContext) => {
      const { name } = context?.receiver;
      AMQPService.logger.silly(`Receiver opened: ${name}`);
      const currentCredits = context.receiver.credit;
      if (currentCredits < credits) {
        AMQPService.logger.silly(`Receiver adding credits: ${name}`);
        context.receiver.addCredit(credits - currentCredits);
      }
    });
    receiver.on(ReceiverEvents.receiverClose, (context: EventContext) => {
      const { name } = context?.receiver;
      AMQPService.logger.silly(`Receiver closed: ${name}`);
    });
    receiver.on(ReceiverEvents.receiverDrained, (context: EventContext) => {
      const { name } = context?.receiver;
      AMQPService.logger.silly(`Remote peer for receiver drained: ${name}`);
    });
    receiver.on(ReceiverEvents.receiverFlow, (context: EventContext) => {
      const { name } = context?.receiver;
      AMQPService.logger.silly(`Flow event received for receiver: ${name}`);
    });
    receiver.on(ReceiverEvents.settled, (context: EventContext) => {
      const { name } = context?.receiver;
      AMQPService.logger.silly(`Message has been settled by remote: ${name}`);
    });
    AMQPService.logger.silly('Receiver created', { credits: receiver?.credit, name: receiver?.name });
    return receiver;
  }
}
