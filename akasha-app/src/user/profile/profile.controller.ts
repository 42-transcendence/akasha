import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  NotFoundException,
  Param,
  ParseFilePipeBuilder,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { AuthPayload, OTPSecret } from "@common/auth-payloads";
import { AuthGuard } from "@/user/auth/auth.guard";
import { Auth } from "@/user/auth/auth.decorator";
import { ProfileService } from "./profile.service";
import {
  AccountProfilePrivatePayload,
  AccountProfileProtectedPayload,
  AccountProfilePublicPayload,
  AchievementElementEntity,
} from "@common/profile-payloads";
import { AccountNickNameAndTag } from "@/user/accounts/accounts.service";
import { NickNameModel, OTPInputModel } from "./profile-model";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  AVATAR_FORM_DATA_KEY,
  AVATAR_LIMIT,
  AVATAR_MIME_REGEX,
} from "@common/profile-constants";
import { NickNamePipe } from "./profile.pipe";
import { GameHistoryEntity, RecordEntity } from "@common/generated/types";

@Controller("profile")
@UseGuards(AuthGuard)
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Get("lookup")
  async lookup(
    @Query("name", NickNamePipe) name: string,
    @Query("tag", ParseIntPipe) tag: number,
  ): Promise<string> {
    const id: string | null = await this.profileService.lookupIdByNick(
      name,
      tag,
    );
    if (id === null) {
      throw new NotFoundException();
    }
    return id;
  }

  @Get("public/:targetId")
  async getPublicProfile(
    @Param("targetId", ParseUUIDPipe) targetId: string,
  ): Promise<AccountProfilePublicPayload> {
    return await this.profileService.getPublicProfile(targetId);
  }

  @Get("public/:targetId/record")
  async getGameRecord(
    @Param("targetId", ParseUUIDPipe) targetId: string,
  ): Promise<RecordEntity> {
    return await this.profileService.getGameRecord(targetId);
  }

  @Get("public/:targetId/achievement")
  async getGameAchievementList(
    @Param("targetId", ParseUUIDPipe) targetId: string,
  ): Promise<AchievementElementEntity[]> {
    return await this.profileService.getAchievements(targetId);
  }

  @Get("public/:targetId/history")
  async getGameHistoryList(
    @Param("targetId", ParseUUIDPipe) targetId: string,
  ): Promise<GameHistoryEntity[]> {
    return await this.profileService.getGameHistoryList(targetId);
  }

  @Get("protected/:targetId")
  async getProtectedProfile(
    @Auth() auth: AuthPayload,
    @Param("targetId", ParseUUIDPipe) targetId: string,
  ): Promise<AccountProfileProtectedPayload> {
    return await this.profileService.getProtectedProfile(auth, targetId);
  }

  @Get("private")
  async getPrivateProfile(
    @Auth() auth: AuthPayload,
  ): Promise<AccountProfilePrivatePayload> {
    return await this.profileService.getPrivateProfile(auth);
  }

  @Post("private/nick")
  async addNick(
    @Auth() auth: AuthPayload,
    @Body() body: NickNameModel,
  ): Promise<AccountNickNameAndTag> {
    return await this.profileService.registerNick(auth, body.nickName);
  }

  @Put("private/nick")
  async changeNick(
    @Auth() auth: AuthPayload,
    @Body() body: NickNameModel,
  ): Promise<AccountNickNameAndTag> {
    return await this.profileService.useNickChanger(auth, body.nickName);
  }

  @Post("private/avatar")
  @UseInterceptors(FileInterceptor(AVATAR_FORM_DATA_KEY))
  async addAvatar(
    @Auth() auth: AuthPayload,
    @UploadedFile(
      new ParseFilePipeBuilder()
        .addFileTypeValidator({
          fileType: AVATAR_MIME_REGEX,
        })
        .addMaxSizeValidator({
          maxSize: AVATAR_LIMIT,
        })
        .build({
          errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        }),
    )
    file: Express.Multer.File,
  ): Promise<string | null> {
    return await this.profileService.updateAvatar(auth, file.buffer);
  }

  @Delete("private/avatar")
  async removeAvatar(@Auth() auth: AuthPayload): Promise<string | null> {
    return await this.profileService.updateAvatar(auth, null);
  }

  @Get("private/otp")
  async getOTPState(@Auth() auth: AuthPayload): Promise<boolean> {
    return await this.profileService.isOTPEnabled(auth);
  }

  @Post("private/otp")
  async getInertOTP(@Auth() auth: AuthPayload): Promise<OTPSecret> {
    return await this.profileService.getInertOTP(auth);
  }

  @Put("private/otp")
  async enableOTP(
    @Auth() auth: AuthPayload,
    @Body() body: OTPInputModel,
  ): Promise<void> {
    return await this.profileService.enableOTP(auth, body.otp);
  }

  @Delete("private/otp")
  async disableOTP(
    @Auth() auth: AuthPayload,
    @Body() body: OTPInputModel,
  ): Promise<void> {
    return await this.profileService.disableOTP(auth, body.otp);
  }

  @Get("check-nick")
  async checkNick(@Body() body: NickNameModel): Promise<boolean> {
    return await this.profileService.checkNick(body.nickName);
  }

  @Get("game/:targetId")
  async getGameDetail(
    @Auth() auth: AuthPayload,
    @Param("targetId", ParseUUIDPipe) targetId: string,
  ): Promise<void> {
    //FIXME: 구현
    void auth;
    void targetId;
  }
}
