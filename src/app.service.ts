import { Logger } from '@dollarsign/logger';
import { AMQP_CONNECTION_DISCONNECTED, AMQPService, Consumer, MessageControl, ProducerService, SendOptions } from '@dollarsign/nestjs-amqp';
import { delay } from '@dollarsign/utils';
import { Injectable } from '@nestjs/common';

import { SimpleMessage } from './interfaces';

@Injectable()
export class AppService {
  private readonly delayTime = 2000;
  private readonly logger = new Logger({
    name: AppService.name,
    displayFilePath: false,
  });

  constructor(private readonly producer: ProducerService) {
    this.bindListener();
  }

  async bindListener() {
    AMQPService.eventEmitter.on(AMQP_CONNECTION_DISCONNECTED, () => {
      this.logger.debug('received disconnected event');
    });
  }

  getHello(): string {
    return 'Hello World!';
  }

  async sendMessage(): Promise<string> {
    const body = { timestamp: new Date().toISOString() };
    const result = await this.producer.send<SimpleMessage>('demo1', body);
    const status = result.status ? 'success' : 'failed';
    return `Send to demo1 of default connection: ${status}`;
  }

  getRandomGroupId(): string {
    const index = Math.floor(Math.random() * 100) % 2;
    const groups = ['GroupA', 'GroupB'];
    return groups[index];
  }

  async sendMessageWithOptions(): Promise<string> {
    const messageId = new Date().getTime();
    const groupId = this.getRandomGroupId();
    const options: SendOptions = {
      connectionName: 'custom',
      group_id: groupId,
      correlation_id: `GROUP:${groupId}`,
      message_id: messageId,
      message_annotations: {
        JMSMessageID: 'A',
      },
    };
    const body = { timestamp: new Date().toISOString() };
    const result = await this.producer.send<SimpleMessage>('demo2', body, options);
    const status = result.status ? 'success' : 'failed';
    return `Send to demo2 of custom connection: ${status}`;
  }

  async sendError(): Promise<string> {
    const message = { timestamp: new Date().toISOString() };
    const result = await this.producer.send<SimpleMessage>('demo3', message);
    const status = result.status ? 'success' : 'failed';
    return `Send to demo3 of default connection: ${status}`;
  }

  @Consumer('demo1')
  async receiveMessage(body: SimpleMessage): Promise<void> {
    this.logger.info('Received from demo1', body);
    await delay(this.delayTime);
  }

  @Consumer('demo2', { connectionName: 'custom', concurrency: 2 })
  async receiveMessageWithOptions(body: SimpleMessage, control: MessageControl): Promise<void> {
    const { message_id, group_id } = control.message;
    this.logger.info(`Received from demo2 id: ${message_id}, ${group_id}`, body);
    await delay(this.delayTime);
    control.accept();
  }

  @Consumer('demo3')
  async receiveError(body: SimpleMessage): Promise<void> {
    this.logger.info('Received from demo3', body);
    await delay(this.delayTime);
    throw new Error(`Created at ${body.timestamp}`);
  }

  async loadTestA(count: number): Promise<void> {
    const topic = 'Topic:LoadTestA';
    const list = Array.from(Array(count).keys());
    for await (const i of list) {
      const body = { index: i, timestamp: new Date().toISOString() };
      const result = await this.producer.send<SimpleMessage>(topic, body);
      if (result.error) {
        this.logger.error(result.error);
      } else {
        this.logger.info(`Send to ${topic}[${i}]`);
      }
    }
  }

  async loadTestB(count: number): Promise<void> {
    const topic = 'Topic:LoadTestB';
    const list = Array.from(Array(count).keys());
    list.forEach(async i => {
      const body = { index: i, timestamp: new Date().toISOString() };
      const result = await this.producer.send<SimpleMessage>(topic, body);
      if (result.error) {
        this.logger.error(result.error);
      } else {
        this.logger.info(`Send to ${topic}[${i}]`);
      }
    });
  }
}
