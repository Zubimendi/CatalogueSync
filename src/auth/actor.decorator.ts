import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ActorClaims } from './auth.service';

export const Actor = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): ActorClaims | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return request.actor;
  },
);
