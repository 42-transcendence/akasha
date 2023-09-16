import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  Achievement,
  ActiveStatus,
  BanCategory,
  GameHistory,
  Prisma,
  Record,
  RegistrationState,
} from "@prisma/client";
import {
  PrismaService,
  PrismaTransactionClient,
} from "@/prisma/prisma.service";
import { TOTP, assert, fromBitsString, generateOTP } from "akasha-lib";
import { FRIEND_ACTIVE_FLAGS_SIZE } from "@common/chat-payloads";
import {
  SecretParams,
  SecretParamsView,
  isSecretParams,
} from "@common/auth-payloads";
import { DEFAULT_SKILL_RATING } from "@common/game-constants";

/// AccountPublic
const accountPublic = Prisma.validator<Prisma.AccountDefaultArgs>()({
  select: { id: true, nickName: true, nickTag: true, avatarKey: true },
});
export type AccountPublic = Prisma.AccountGetPayload<typeof accountPublic>;

/// AccountProtected
const accountProtected = Prisma.validator<Prisma.AccountDefaultArgs>()({
  select: {
    ...accountPublic.select,
    activeStatus: true,
    activeTimestamp: true,
    statusMessage: true,
  },
});
export type AccountProtected = Prisma.AccountGetPayload<
  typeof accountProtected
>;

/// AccountPrivate
const accountPrivate = Prisma.validator<Prisma.AccountDefaultArgs>()({
  select: { ...accountProtected.select },
});
export type AccountPrivate = Prisma.AccountGetPayload<typeof accountPrivate>;

/// AccountForAuth
const accountForAuth = Prisma.validator<Prisma.AccountDefaultArgs>()({
  include: { otpSecret: true, bans: true },
});
export type AccountForAuth = Prisma.AccountGetPayload<typeof accountForAuth>;

const activeBanCondition = (): Prisma.BanWhereInput => ({
  OR: [{ expireTimestamp: null }, { expireTimestamp: { gte: new Date() } }],
});

const activeAccessBanCondition = (): Prisma.BanWhereInput => ({
  AND: [{ category: BanCategory.ACCESS }, activeBanCondition()],
});

/// AccountNickNameAndTag
const accountNickNameAndTag = Prisma.validator<Prisma.AccountDefaultArgs>()({
  select: { nickName: true, nickTag: true },
});
export type AccountNickNameAndTag = Prisma.AccountGetPayload<
  typeof accountNickNameAndTag
>;

/// SecretValues
const secretValues = Prisma.validator<Prisma.SecretDefaultArgs>()({
  select: { data: true, params: true },
});
export type SecretValues = Prisma.SecretGetPayload<typeof secretValues>;

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  async isAvailableAccount(id: string): Promise<boolean> {
    const account = await this.prisma.account.findUnique({
      where: { id },
      select: { nickName: true },
    });
    return account !== null && account.nickName !== null;
  }

  async findAccountPublic(id: string): Promise<AccountPublic | null> {
    return await this.prisma.account.findUnique({
      where: { id },
      ...accountPublic,
    });
  }

  async findAccountProtected(id: string): Promise<AccountProtected | null> {
    return await this.prisma.account.findUnique({
      where: { id },
      ...accountProtected,
    });
  }

  async findAccountPrivate(id: string): Promise<AccountPrivate | null> {
    return await this.prisma.account.findUnique({
      where: { id },
      ...accountPrivate,
    });
  }

  async findAccountIdByNick(name: string, tag: number): Promise<string | null> {
    const account = await this.prisma.account.findUnique({
      where: { nickName_nickTag: { nickName: name, nickTag: tag } },
      select: { id: true },
    });
    return account?.id ?? null;
  }

  async findOrCreateAccountForAuth(
    authIssuer: number,
    authSubject: string,
  ): Promise<AccountForAuth> {
    const authIssuer_authSubject: Prisma.AccountAuthIssuerAuthSubjectCompoundUniqueInput =
      { authIssuer, authSubject };
    return await this.prisma.account.upsert({
      where: { authIssuer_authSubject },
      update: {},
      create: {
        ...authIssuer_authSubject,
        registrationState: RegistrationState.REGISTERED,
        changedTimestamp: new Date(),
        activeStatus: ActiveStatus.ONLINE,
        activeTimestamp: new Date(),
        record: { create: { skillRating: DEFAULT_SKILL_RATING } },
      },
      include: {
        otpSecret: true,
        bans: { where: activeAccessBanCondition() },
      },
    });
  }

  async findAccountForAuth(id: string): Promise<AccountForAuth> {
    return await this.prisma.account.findUniqueOrThrow({
      where: { id },
      include: {
        otpSecret: true,
        bans: { where: activeAccessBanCondition() },
      },
    });
  }

  async findActiveBansOnTransaction(tx: PrismaTransactionClient, id: string) {
    const account = await tx.account.findUniqueOrThrow({
      where: { id },
      select: {
        bans: {
          where: activeBanCondition(),
        },
      },
    });
    return account.bans;
  }

  async checkOTP(secret: SecretValues, clientOTP: string): Promise<boolean> {
    const params = secret.params;
    if (!isSecretParams(params)) {
      throw new InternalServerErrorException("Corrupted OTP param");
    }

    const movingFactor = TOTP.getMovingFactor(params.movingPeriod);

    const serverOTP: string = await generateOTP(
      secret.data,
      movingFactor,
      params.codeDigits,
      params.algorithm,
    );

    return serverOTP === clientOTP;
  }

  async getOTPState(id: string): Promise<boolean> {
    const account = await this.prisma.account.findUniqueOrThrow({
      where: { id },
      select: {
        otpSecret: secretValues,
      },
    });

    if (account.otpSecret !== null) {
      const params = account.otpSecret.params;
      if (!isSecretParams(params)) {
        throw new InternalServerErrorException("Corrupted OTP param");
      }

      return params.enabled;
    } else {
      return false;
    }
  }

  async createOTPSecretAtomic(
    id: string,
    supplier: () => Promise<[Uint8Array, SecretParamsView]>,
  ): Promise<SecretValues> {
    return this.prisma.$transaction(async (tx) => {
      // 1. Check Exists Secret
      const account = await tx.account.findUniqueOrThrow({
        where: { id },
        select: {
          otpSecret: secretValues,
        },
      });

      if (account.otpSecret !== null) {
        // 2-A. Remaining Midway Data
        const params = account.otpSecret.params;
        if (!isSecretParams(params)) {
          throw new InternalServerErrorException("Corrupted OTP param");
        }

        // Not Midway
        if (params.enabled) {
          throw new ConflictException("Enabled otpSecret already exists");
        }

        return account.otpSecret;
      } else {
        // 2-B. Create New Secret
        const data = await supplier();
        const insertedSecret = await tx.secret.create({
          data: {
            data: Buffer.from(data[0]),
            params: { ...data[1], enabled: false } satisfies SecretParams,
          },
        });
        const changedAccount = await tx.account.update({
          where: { id },
          data: { otpSecret: { connect: { id: insertedSecret.id } } },
          select: {
            otpSecret: secretValues,
          },
        });

        assert(changedAccount.otpSecret !== null);
        return changedAccount.otpSecret;
      }
    });
  }

  async updateOTPSecretAtomic(id: string, clientOTP: string): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      // 1. Load Secret
      const account = await tx.account.findUniqueOrThrow({
        where: { id },
        select: {
          otpSecret: { select: { ...secretValues.select, id: true } },
        },
      });

      if (account.otpSecret === null) {
        throw new BadRequestException();
      }
      if (!(await this.checkOTP(account.otpSecret, clientOTP))) {
        throw new UnauthorizedException("Wrong OTP");
      }
      const params = account.otpSecret.params;
      if (!isSecretParams(params)) {
        throw new BadRequestException();
      }
      if (params.enabled) {
        throw new ConflictException("Already enabled OTP");
      }

      // 2. Enable Secret
      const changedAccount = await tx.secret.update({
        where: { id: account.otpSecret.id },
        data: {
          params: { ...params, enabled: true } satisfies SecretParams,
        },
        ...secretValues,
      });
      void changedAccount;
    });
  }

  async deleteOTPSecretAtomic(id: string, clientOTP: string): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      // 1. Load Exists Secret
      const account = await tx.account.findUniqueOrThrow({
        where: { id },
        select: {
          otpSecret: { select: { ...secretValues.select, id: true } },
        },
      });

      if (account.otpSecret === null) {
        throw new BadRequestException();
      }
      if (!(await this.checkOTP(account.otpSecret, clientOTP))) {
        throw new UnauthorizedException("Wrong OTP");
      }

      // 2. Delete Secret
      const updatedAccount = await tx.account.update({
        where: { id },
        data: { otpSecret: { disconnect: true } }, //NOTE: Restricted
      });
      void updatedAccount;
      const deletedSecret = await tx.secret.delete({
        where: { id: account.otpSecret.id },
      });
      void deletedSecret;
    });
  }

  async findActiveStatus(id: string): Promise<ActiveStatus> {
    const account = await this.prisma.account.findUniqueOrThrow({
      where: { id },
      select: { activeStatus: true },
    });
    return account?.activeStatus;
  }

  async updateActiveStatus(
    id: string,
    activeStatus: ActiveStatus,
  ): Promise<void> {
    const account = await this.prisma.account.update({
      where: { id },
      data: { activeStatus },
    });
    void account;
  }

  async updateActiveTimestamp(id: string): Promise<void> {
    const account = await this.prisma.account.update({
      where: { id },
      data: { activeTimestamp: new Date() },
    });
    void account;
  }

  async updateStatusMessage(id: string, statusMessage: string): Promise<void> {
    const account = await this.prisma.account.update({
      where: { id },
      data: { statusMessage },
    });
    void account;
  }

  async findFriendActiveFlags(
    id: string,
    friendId: string,
  ): Promise<number | null> {
    const friendReverse = await this.prisma.friend.findUnique({
      where: {
        accountId_friendAccountId: {
          accountId: friendId,
          friendAccountId: id,
        },
      },
      select: {
        activeFlags: true,
      },
    });
    if (friendReverse === null) {
      return null;
    }

    return fromBitsString(friendReverse.activeFlags, FRIEND_ACTIVE_FLAGS_SIZE);
  }

  async updateNickAtomic(
    id: string,
    name: string,
    tagHint: number | undefined,
    overwrite: boolean,
  ): Promise<AccountNickNameAndTag> {
    return this.prisma.x.$transaction(async (tx) => {
      // 1. Check Exists Nick
      const account = await tx.account.findUniqueOrThrow({
        where: { id },
        select: { nickName: true },
      });
      if (!overwrite && account.nickName !== null) {
        throw new BadRequestException("nickName already exists");
      }

      // 2. Pick Random Tag
      const tagNumberQuery = await tx.account.generateTagNumber(name, tagHint);
      if (!Array.isArray(tagNumberQuery) || tagNumberQuery.length === 0) {
        throw new ConflictException(
          `No more tagNumber left for name [${name}]`,
        );
      }
      const [{ tagNumber: tagNumberRaw }] = tagNumberQuery;
      const tagNumber = Number(tagNumberRaw);

      // 3. Update Nick
      return await tx.account.update({
        where: { id },
        data: {
          nickName: name,
          nickTag: tagNumber,
        },
        ...accountNickNameAndTag,
      });
    });
  }

  async updateAvatarAtomic(
    id: string,
    avatarData: Buffer | null,
  ): Promise<string | null> {
    return this.prisma.$transaction(async (tx) => {
      // 1. Load Exists Avatar
      const account = await tx.account.findUniqueOrThrow({
        where: { id },
        select: { avatarKey: true },
      });

      // 2. Delete Avatar If Exists
      if (account.avatarKey !== null) {
        const deletedAvatar = await tx.avatar.delete({
          where: { id: account.avatarKey },
        });
        void deletedAvatar;
      }

      if (avatarData !== null) {
        // 3-A. Insert Updated Avatar
        const insertedAvatar = await tx.avatar.create({
          data: { data: avatarData },
        });
        const changedAccount = await tx.account.update({
          where: { id },
          data: { avatarKey: insertedAvatar.id },
          select: { avatarKey: true },
        });
        return changedAccount.avatarKey;
      } else {
        // 3-B. Delete Avatar On Account
        //NOTE: Expect account to have been updated by `ON DELETE SET DEFAULT`
        return null;
      }
    });
  }

  async findAvatar(key: string): Promise<Buffer> {
    const avatar = await this.prisma.avatar.findUniqueOrThrow({
      where: { id: key },
    });
    return avatar.data;
  }

  async findGameRecord(id: string): Promise<Record | null> {
    const account = await this.prisma.account.findUnique({
      where: { id },
      select: { record: true },
    });
    return account?.record ?? null;
  }

  async findAchievements(id: string): Promise<Achievement[] | null> {
    const account = await this.prisma.account.findUnique({
      where: { id },
      select: { record: { select: { achievements: true } } },
    });
    return account?.record?.achievements ?? null;
  }

  async findGameHistoryList(
    id: string,
    take?: number | undefined,
  ): Promise<GameHistory[] | null> {
    const account = await this.prisma.account.findUnique({
      where: { id },
      select: {
        gameHistory: { orderBy: { timestamp: Prisma.SortOrder.desc }, take },
      },
    });
    return account?.gameHistory ?? null;
  }

  async findGameHistory(id: string): Promise<GameHistory | null> {
    const gameHistory = await this.prisma.gameHistory.findUnique({
      where: { id },
    });
    return gameHistory;
  }
}
