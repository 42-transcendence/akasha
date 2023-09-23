import { NICK_NAME_REGEX } from "@common/profile-constants";
import { NickNamePayload, OTPInputPayload } from "@common/profile-payloads";
import { IsString, Matches } from "class-validator";

/// NickNameModel
export class NickNameModel implements NickNamePayload {
  @IsString() @Matches(NICK_NAME_REGEX) readonly nickName;

  constructor(nickName: string) {
    this.nickName = nickName;
  }
}

/// OTPInputModel
export class OTPInputModel implements OTPInputPayload {
  @IsString() readonly otp;

  constructor(otp: string) {
    this.otp = otp;
  }
}
