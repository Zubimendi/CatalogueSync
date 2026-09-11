import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';

// Safely serialize BigInt values to string in JSON responses
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableShutdownHooks();

  const port = process.env.HTTP_PORT ? parseInt(process.env.HTTP_PORT, 10) : 3000;
  await app.listen(port);
  logger.log(`CatalogSync API server running on port ${port}`);
}

bootstrap();
