import { Controller, Post, Body } from '@nestjs/common';
import { AuthService, ActorClaims } from './auth.service';

export class IssueTokenDto {
  actorId: string;
  vendorId?: string;
  roles?: string[];
}

@Controller('v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('token')
  issueToken(@Body() dto: IssueTokenDto) {
    const token = this.authService.issueToken({
      actorId: dto.actorId,
      vendorId: dto.vendorId,
      roles: dto.roles || ['user'],
    });
    return { token };
  }
}
