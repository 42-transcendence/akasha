import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import {
  AccountNickNameAndTag,
  AccountPrivate,
  AccountProtected,
  AccountPublic,
  AccountsService,
  AchievementElement,
  SecretValues,
} from "@/user/accounts/accounts.service";
import {
  AuthLevel,
  AuthPayload,
  OTPSecret,
  isSecretParams,
} from "@common/auth-payloads";
import {
  ActiveStatus,
  ActiveStatusNumber,
  GameHistoryEntity,
  RecordEntity,
  getActiveStatusNumber,
} from "@common/generated/types";
import {
  AccountProfilePrivatePayload,
  AccountProfileProtectedPayload,
  AccountProfilePublicPayload,
  AchievementElementEntity,
} from "@common/profile-payloads";
import { MAX_GAME_HISTORY, NICK_NAME_REGEX } from "@common/profile-constants";
import { ChatServer } from "@/service/chat/chat.server";
import { GameServer } from "@/service/game/game.server";
import { FriendActiveFlags } from "@common/chat-payloads";
import { encodeBase32, generateHMACKey } from "akasha-lib";
import { GameHistory, Record } from "@prisma/client";

@Injectable()
export class ProfileService {
  constructor(
    private readonly accounts: AccountsService,
    private readonly chatServer: ChatServer,
    private readonly gameServer: GameServer,
  ) {}

  async getPublicProfile(
    targetAccountId: string,
  ): Promise<AccountProfilePublicPayload> {
    const targetAccount: AccountPublic | null =
      await this.accounts.findAccountPublic(targetAccountId);
    if (targetAccount === null) {
      throw new NotFoundException();
    }

    return { ...targetAccount };
  }

  async getProtectedProfile(
    payload: AuthPayload,
    targetAccountId: string,
  ): Promise<AccountProfileProtectedPayload> {
    if (payload.auth_level === AuthLevel.COMPLETED) {
      if (payload.user_id === targetAccountId) {
        return await this.getPrivateProfile(payload);
      }

      const activeFlags = await this.accounts.findFriendActiveFlags(
        payload.user_id,
        targetAccountId,
      );

      if (activeFlags === null) {
        throw new ForbiddenException("Not duplex friend");
      }

      const targetAccount: AccountProtected | null =
        await this.accounts.findAccountProtected(targetAccountId);
      if (targetAccount === null) {
        throw new NotFoundException();
      }

      let activeStatus: ActiveStatusNumber;
      if ((activeFlags & FriendActiveFlags.SHOW_ACTIVE_STATUS) !== 0) {
        activeStatus = await this.getActiveStatus(targetAccountId);
      } else {
        // Hide activeStatus
        activeStatus = ActiveStatusNumber.OFFLINE;
      }

      let activeTimestamp: Date;
      if ((activeFlags & FriendActiveFlags.SHOW_ACTIVE_TIMESTAMP) !== 0) {
        activeTimestamp = targetAccount.activeTimestamp;
      } else {
        // Hide activeTimestamp
        activeTimestamp = new Date(0);
      }

      let statusMessage: string;
      if ((activeFlags & FriendActiveFlags.SHOW_STATUS_MESSAGE) !== 0) {
        statusMessage = targetAccount.statusMessage;
      } else {
        // Hide statusMessage
        statusMessage = "";
      }

      return {
        ...targetAccount,
        activeStatus,
        activeTimestamp,
        statusMessage,
      };
    }
    throw new ForbiddenException();
  }

  async getPrivateProfile(
    payload: AuthPayload,
  ): Promise<AccountProfilePrivatePayload> {
    if (payload.auth_level === AuthLevel.COMPLETED) {
      const targetAccount: AccountPrivate | null =
        await this.accounts.findAccountPrivate(payload.user_id);
      if (targetAccount === null) {
        throw new NotFoundException();
      }

      return {
        ...targetAccount,
        activeStatus: getActiveStatusNumber(targetAccount.activeStatus),
      };
    }
    throw new ForbiddenException();
  }

  async lookupIdByNick(name: string, tag: number): Promise<string | null> {
    return await this.accounts.findAccountIdByNick(name, tag);
  }

  async isOTPEnabled(payload: AuthPayload): Promise<boolean> {
    if (payload.auth_level === AuthLevel.COMPLETED) {
      return await this.accounts.getOTPState(payload.user_id);
    }
    throw new ForbiddenException();
  }

  async getInertOTP(payload: AuthPayload): Promise<OTPSecret> {
    if (payload.auth_level === AuthLevel.COMPLETED) {
      const algorithm = "SHA-256";
      const codeDigits = 6;
      const movingPeriod = 30;

      const secret: SecretValues = await this.accounts.createOTPSecretAtomic(
        payload.user_id,
        async () => [
          await generateHMACKey(algorithm),
          { algorithm, codeDigits, movingPeriod },
        ],
      );
      const params = secret.params;
      if (!isSecretParams(params)) {
        throw new InternalServerErrorException("Corrupted OTP param");
      }

      return { data: encodeBase32(secret.data), ...params };
    }
    throw new ForbiddenException();
  }

  async enableOTP(payload: AuthPayload, clientOTP: string): Promise<void> {
    if (payload.auth_level === AuthLevel.COMPLETED) {
      return await this.accounts.updateOTPSecretAtomic(
        payload.user_id,
        clientOTP,
      );
    }
    throw new ForbiddenException();
  }

  async disableOTP(payload: AuthPayload, clientOTP: string): Promise<void> {
    if (payload.auth_level === AuthLevel.COMPLETED) {
      return await this.accounts.deleteOTPSecretAtomic(
        payload.user_id,
        clientOTP,
      );
    }
    throw new ForbiddenException();
  }

  async getActiveStatus(
    targetAccountId: string,
    activeStatusHint: ActiveStatus | null = null,
  ): Promise<ActiveStatusNumber> {
    let activeStatus = activeStatusHint;
    if (activeStatus === null) {
      activeStatus = await this.accounts.findActiveStatus(targetAccountId);
    }

    const manualActiveStatus = getActiveStatusNumber(activeStatus);
    if (manualActiveStatus === ActiveStatusNumber.INVISIBLE) {
      return ActiveStatusNumber.OFFLINE;
    }

    // // ActiveStatusNumber.GAME ||| ActiveStatusNumber.MATCHING
    // const gameActiveStatus = await LocalServer.Games.getActiveStatus(targetAccountId);
    const gameActiveStatus =
      await this.gameServer.getActiveStatus(targetAccountId);
    if (gameActiveStatus !== ActiveStatusNumber.OFFLINE) {
      return gameActiveStatus;
    }

    // // ActiveStatusNumber.ONLINE ||| ActiveStatusNumber.IDLE ||| ActiveStatusNumber.OFFLINE
    // const chatActiveStatus = await LocalServer.Chats.getActiveStatus(targetAccountId);
    const chatActiveStatus =
      await this.chatServer.getActiveStatus(targetAccountId);
    if (
      chatActiveStatus !== ActiveStatusNumber.OFFLINE &&
      manualActiveStatus !== ActiveStatusNumber.ONLINE
    ) {
      return manualActiveStatus;
    }

    return chatActiveStatus;
  }

  async checkNick(name: string): Promise<boolean> {
    if (!NICK_NAME_REGEX.test(name)) {
      return false;
    }

    return true;
  }

  async registerNick(
    payload: AuthPayload,
    name: string,
  ): Promise<AccountNickNameAndTag> {
    if (payload.auth_level === AuthLevel.COMPLETED) {
      if (!(await this.checkNick(name))) {
        throw new BadRequestException();
      }

      return await this.accounts.updateNickAtomic(
        payload.user_id,
        name,
        undefined,
        false,
      );
    }
    throw new ForbiddenException();
  }

  async useNickChanger(
    payload: AuthPayload,
    name: string,
  ): Promise<AccountNickNameAndTag> {
    if (payload.auth_level === AuthLevel.COMPLETED) {
      if (!(await this.checkNick(name))) {
        throw new BadRequestException();
      }

      return await this.accounts.updateNickAtomic(
        payload.user_id,
        name,
        AccountsService.KeepNickTag,
        true,
      );
    }
    throw new ForbiddenException();
  }

  async updateAvatar(
    payload: AuthPayload,
    avatarData: Buffer | null,
  ): Promise<string | null> {
    if (payload.auth_level === AuthLevel.COMPLETED) {
      const key = await this.accounts.updateAvatarAtomic(
        payload.user_id,
        avatarData,
      );
      return key;
    }
    throw new ForbiddenException();
  }

  async getGameRecord(targetAccountId: string): Promise<RecordEntity> {
    const record: Record | null =
      await this.accounts.findGameRecord(targetAccountId);
    if (record === null) {
      throw new NotFoundException();
    }

    return record;
  }

  async getAchievements(
    targetAccountId: string,
  ): Promise<AchievementElementEntity[]> {
    const achievements: AchievementElement[] | null =
      await this.accounts.findAchievements(targetAccountId);
    if (achievements === null) {
      throw new NotFoundException();
    }

    return achievements;
  }

  async getGameHistoryList(
    targetAccountId: string,
  ): Promise<GameHistoryEntity[]> {
    const gameHistoryList: GameHistory[] | null =
      await this.accounts.findGameHistoryList(
        targetAccountId,
        MAX_GAME_HISTORY,
      );
    if (gameHistoryList === null) {
      throw new NotFoundException();
    }

    return gameHistoryList;
  }

  async getGameHistory(gameId: string): Promise<GameHistoryEntity> {
    const gameHistory: GameHistory | null =
      await this.accounts.findGameHistory(gameId);
    if (gameHistory === null) {
      throw new NotFoundException();
    }

    return gameHistory;
  }
}
