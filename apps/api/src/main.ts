import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { Pool } from 'pg';
import { AppModule } from './app.module';

async function bootstrap() {
  if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
    throw new Error('SESSION_SECRET de al menos 32 caracteres es obligatorio en producción');
  }
  const app = await NestFactory.create(AppModule);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const PgSession = connectPgSimple(session);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: process.env.WEB_ORIGIN || 'http://localhost:5173', credentials: true });
  app.use(session({ store: new PgSession({ pool, tableName: 'sessions', createTableIfMissing: false }),
    secret: process.env.SESSION_SECRET || 'development-only-change-this-secret-please', resave: false,
    saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 12 } }));
  const config = new DocumentBuilder().setTitle('Bar Manager API').setVersion('1.0').addCookieAuth('connect.sid').build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
  await app.listen(Number(process.env.PORT || 3000));
}
bootstrap();
