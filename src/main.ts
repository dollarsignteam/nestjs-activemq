import { Logger } from '@dollarsign/logger';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

const logger = new Logger('NestApplication');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger,
  });

  const port = process.env.APP_PORT || 3000;
  await app.listen(port);
}

(async (): Promise<void> => {
  await bootstrap();
})().catch((error: Error) => {
  logger.error(`Nest application error: ${error.message}`);
  process.exit(1);
});
