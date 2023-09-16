import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import { GameConfiguration } from "./game-config";
import { PrismaService } from "@/prisma/prisma.service";
import {
  GameInvitationPayload,
  GameMemberStatistics,
  GameOutcome,
  GameRoomEnterResult,
  GameRoomParams,
  GameStatistics,
  isGameInvitationPayload,
} from "@common/game-payloads";
import { GameEntity } from "@common/generated/types";
import { jwtVerifyHMAC } from "akasha-lib";
import { GameServer } from "./game.server";
import { Prisma } from "@prisma/client";
import { GameRoom } from "./game-room";
import * as Glicko from "./game-rating";

/// AcceptInvitationResult
type AcceptInvitationResult =
  | { errno: GameRoomEnterResult.SUCCESS; room: GameRoom }
  | { errno: Exclude<GameRoomEnterResult, GameRoomEnterResult.SUCCESS> };

@Injectable()
export class GameService implements OnApplicationBootstrap, OnModuleDestroy {
  protected static readonly logger = new Logger(GameService.name);

  private readonly config: GameConfiguration;
  private readonly rooms = new Map<string, GameRoom>();

  constructor(
    env: ConfigService,
    private readonly prisma: PrismaService,
    private readonly server: GameServer,
  ) {
    const config = GameConfiguration.load(env);
    this.config = config;
  }

  async onApplicationBootstrap(): Promise<void> {
    const oldGameServer = await this.prisma.gameServer.findUnique({
      where: { id: this.config.unique_id },
    });
    if (oldGameServer !== null) {
      GameService.logger.fatal(
        "An active game server with the same unique ID already exists. The unique ID may have been misconfigured or the previous session may have been crashed.",
      );
      // throw new Error();
      //FIXME: DEV
      void (await this.prisma.gameServer.delete({
        where: { id: this.config.unique_id },
      }));
    }

    const gameServer = await this.prisma.gameServer.create({
      data: { id: this.config.unique_id },
    });
    void gameServer;
  }

  async onModuleDestroy(): Promise<void> {
    const promises = Array<Promise<void>>();
    for (const room of this.rooms.values()) {
      promises.push(room.dispose());
    }
    this.rooms.clear();
    void (await Promise.allSettled(promises));

    try {
      void (await this.prisma.gameServer.delete({
        where: { id: this.config.unique_id },
      }));
    } catch (e) {
      GameService.logger.fatal(
        "Game servers with the same unique ID have already disappeared from the list. The unique ID may have been configured as a duplicate or may have been deleted manually.",
      );
    }
  }

  async extractInvitation(
    token: string,
  ): Promise<GameInvitationPayload | null> {
    const verify = await jwtVerifyHMAC(
      token,
      GameConfiguration.JWT_ALGORITHM,
      this.config.jwt_secret,
      this.config.jwt_options,
    );

    if (!verify.success) {
      return null;
    }

    const payload: Record<string, unknown> = verify.payload;
    if (!isGameInvitationPayload(payload)) {
      throw new Error("Unexpected JWT Payload");
    }
    return payload;
  }

  async createNewRoom(
    params: GameRoomParams,
    ladder: boolean,
  ): Promise<GameEntity> {
    const game = await this.prisma.game.create({
      data: {
        serverId: this.config.unique_id,
        code: ladder ? null : undefined,
      },
    });
    const room = new GameRoom(this, this.server, game, params, ladder);
    this.rooms.set(room.props.id, room);
    return room.props;
  }

  async removeRoom(gameId: string): Promise<void> {
    if (this.rooms.delete(gameId)) {
      try {
        void (await this.prisma.game.delete({ where: { id: gameId } }));
      } catch (e) {
        GameService.logger.fatal(
          "Game room has already disappeared from database.",
        );
      }
    }
  }

  @Interval(10000)
  pruneUnusedRoom() {
    const now = Date.now();
    GameService.logger.debug(`Before prune rooms: ${this.rooms.size}`);

    const promises = Array<Promise<void>>();
    for (const [, room] of this.rooms) {
      if (room.unused && room.createdTimestamp + 7000 < now) {
        promises.push(room.dispose()); //NOTE: concurrent modification
      }
    }
    Promise.all(promises)
      .then(() => {
        GameService.logger.debug(`After prune rooms: ${this.rooms.size}`);
      })
      .catch((e) => {
        GameService.logger.error(`Failed prune rooms: ${e}`);
      });
  }

  getRoom(gameId: string): GameRoom | undefined {
    return this.rooms.get(gameId);
  }

  async acceptInvitation(
    accountId: string,
    token: string,
  ): Promise<AcceptInvitationResult> {
    const invitation: GameInvitationPayload | null =
      await this.extractInvitation(token);
    if (invitation === null) {
      return { errno: GameRoomEnterResult.EXPIRED_INVITATION };
    }
    if (invitation.user_id !== accountId) {
      return { errno: GameRoomEnterResult.ACCOUNT_MISMATCH };
    }
    if (invitation.server_id !== this.config.unique_id) {
      return { errno: GameRoomEnterResult.SERVER_MISMATCH };
    }
    const observer = invitation.observer !== undefined;
    const room: GameRoom | undefined = this.rooms.get(invitation.game_id);
    if (room === undefined) {
      return { errno: GameRoomEnterResult.NOT_FOUND };
    }
    return await this.prisma.$transaction(async (tx) => {
      if (!observer) {
        const account = await tx.account.findUniqueOrThrow({
          where: { id: accountId },
          select: {
            game: true,
            record: {
              select: { skillRating: true, ratingDeviation: true },
            },
            gameHistory: {
              where: { ladder: true },
              orderBy: { timestamp: Prisma.SortOrder.desc },
              select: { timestamp: true },
              take: Glicko.MAX_RATING_DEVIATION_HISTORY_LIMIT,
            },
          },
        });
        const record = account.record;
        if (record === null) {
          return { errno: GameRoomEnterResult.UNKNOWN };
        }
        const game = account.game;
        if (game === null) {
          // EnterRoom
          if (room.members.size >= room.params.limit) {
            return { errno: GameRoomEnterResult.EXCEED_LIMIT };
          }
          if (room.progress !== undefined) {
            return { errno: GameRoomEnterResult.ALREADY_STARTED };
          }
          void (await tx.account.update({
            where: { id: accountId },
            data: { gameId: room.props.id },
          }));
          room.addMember(
            accountId,
            record.skillRating,
            Glicko.calcRatingDeviation(
              record.ratingDeviation,
              account.gameHistory.map((e) => e.timestamp),
            ),
          );
        } else {
          // ResumeRoom
          if (game.id !== invitation.game_id) {
            return { errno: GameRoomEnterResult.GAME_MISMATCH };
          }
          //TODO: room.resumePlayer
          throw new Error("Not implemented");
        }
      } else {
        // ObserveRoom
        //TODO: room.addObserver
        throw new Error("Not implemented");
      }
      return { errno: GameRoomEnterResult.SUCCESS, room };
    });
  }

  async notifyDisconnect(accountId: string, gameId: string): Promise<void> {
    const room: GameRoom | undefined = this.rooms.get(gameId);
    if (room !== undefined) {
      //TODO: room.suspendPlayer if `room.started`
      room.removeMember(accountId);
      try {
        void (await this.prisma.account.update({
          where: { id: accountId },
          data: { gameId: null },
        }));
      } catch (e) {
        GameService.logger.fatal("Game has already disappeared from database.");
      }
      if (room.members.size === 0) {
        await room.dispose();
      }
    }
  }

  async saveGameResult(
    statistics: GameStatistics,
    memberStatistics: GameMemberStatistics[],
  ) {
    await this.prisma.$transaction(async (tx) => {
      if (statistics.ladder) {
        for (const member of memberStatistics) {
          await tx.record.update({
            where: { accountId: member.accountId },
            data: {
              winCount:
                member.outcome === GameOutcome.WIN
                  ? { increment: 1 }
                  : undefined,
              loseCount:
                member.outcome === GameOutcome.LOSE
                  ? { increment: 1 }
                  : undefined,
              tieCount:
                member.outcome === GameOutcome.TIE
                  ? { increment: 1 }
                  : undefined,
              skillRating: member.finalSkillRating,
              ratingDeviation: member.finalRatingDeviation,
            },
          });
        }
      }
      await tx.gameHistory.create({
        data: {
          id: statistics.gameId,
          ladder: statistics.ladder,
          timestamp: statistics.timestamp,
          statistic: statistics,
          memberStatistics,
          members: {
            connect: memberStatistics.map((e) => ({
              id: e.accountId,
            })),
          },
        },
      });
    });
  }

  async accomplishAchievement(
    accountId: string,
    achievementId: number,
  ): Promise<boolean> {
    try {
      void (await this.prisma.achievement.create({
        data: { accountId, achievementId },
      }));
      return true;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code === "P2002") {
          return false;
        }
      }
      GameService.logger.error(`Failed accomplish achievement: ${e}`);
      throw e;
    }
  }
}
