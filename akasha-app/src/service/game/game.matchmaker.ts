import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import { PrismaService } from "@/prisma/prisma.service";
import { jwtSignatureHMAC } from "akasha-lib";
import {
  BattleField,
  GameInvitationPayload,
  GameMode,
  GameRoomParams,
  MatchmakeFailedReason,
} from "@common/game-payloads";
import { GameConfiguration } from "./game-config";
import { GameService } from "./game.service";
import { GameServer } from "./game.server";
import { GameQueue, Prisma } from "@prisma/client";
import * as builder from "./game-payload-builder";

@Injectable()
export class GameMatchmaker {
  protected static readonly logger = new Logger(GameMatchmaker.name);

  private readonly config: GameConfiguration;

  constructor(
    env: ConfigService,
    private readonly prisma: PrismaService,
    private readonly service: GameService,
    private readonly server: GameServer,
  ) {
    const config = GameConfiguration.load(env);
    if (config.jwt_secret.length < 32) {
      GameMatchmaker.logger.warn(
        "Security threat: Matchmaking is vulnerable because JWT Secret is configured too short.",
      );
    }
    this.config = config;
  }

  async checkDuplicateSession(accountId: string): Promise<boolean> {
    const account = await this.prisma.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { gameQueue: true, game: true },
    });
    return account.gameQueue !== null || account.game !== null;
  }

  async matchEnqueue(
    accountId: string,
  ): Promise<MatchmakeFailedReason | undefined> {
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.findUniqueOrThrow({
        where: { id: accountId },
        select: {
          gameQueue: true,
          game: true,
          record: { select: { skillRating: true } },
        },
      });
      if (account.gameQueue !== null || account.game !== null) {
        return MatchmakeFailedReason.DUPLICATE;
      }
      if (account.record === null) {
        return MatchmakeFailedReason.UNKNOWN;
      }

      const queue = await tx.gameQueue.create({
        data: {
          accountId,
          serverId: this.config.unique_id,
          skillRating: account.record.skillRating,
        },
      });
      void queue;
      return undefined;
    });
  }

  async matchDequeue(accountId: string): Promise<void> {
    try {
      await this.prisma.gameQueue.delete({ where: { accountId } });
    } catch (e) {
      GameMatchmaker.logger.warn(`Match dequeue failure: ${e}`);
    }
  }

  static params: GameRoomParams = {
    battleField: BattleField.SQUARE,
    gameMode: GameMode.UNIFORM,
    limit: 2,
    fair: true,
  };

  static getMatchCoverage(elapsedTime: number): number {
    if (elapsedTime < 5000) {
      // 5초 이내, +-250
      return 500;
    } else if (elapsedTime < 10000) {
      // 10초 이내, +-400
      return 800;
    }
    // 이후, +-1000
    return 2000;
  }

  static isMatchable(ranges: (readonly [number, number])[]) {
    const minUpper = ranges
      .map((e) => e[1])
      .reduce((e1, e2) => (e1 < e2 ? e1 : e2));
    const maxLower = ranges
      .map((e) => e[0])
      .reduce((e1, e2) => (e1 > e2 ? e1 : e2));
    if (maxLower > minUpper) {
      return false;
    }
    for (const [lower, upper] of ranges) {
      if (lower > minUpper) {
        return false;
      }
      if (maxLower > upper) {
        return false;
      }
    }
    return true;
  }

  @Interval(4000)
  //XXX: Shutdown 때 Promise가 중단되지 않음.
  async matchmake() {
    Logger.debug(`Begin matchmake`, GameMatchmaker.name);
    const now = Date.now();
    const matchedTupleSet = await this.prisma.$transaction(async (tx) => {
      const matchedTupleSet = new Set<GameQueue[]>();

      const queue = await tx.gameQueue.findMany({
        orderBy: { skillRating: Prisma.SortOrder.asc },
      });
      Logger.debug(
        `Total ${queue.length} element(s) for matchmaking.`,
        GameMatchmaker.name,
      );

      const rangedQueue = queue.map((e) => {
        const elapsedTime = now - e.timestamp.valueOf();
        const coverage = GameMatchmaker.getMatchCoverage(elapsedTime);
        return {
          ...e,
          range: [
            e.skillRating - coverage / 2,
            e.skillRating + coverage / 2,
          ] as const,
        };
      });
      const size = GameMatchmaker.params.limit;
      for (;;) {
        const spliced = rangedQueue.splice(0, size);
        if (spliced.length !== size) {
          break;
        }

        if (GameMatchmaker.isMatchable(spliced.map((e) => e.range))) {
          matchedTupleSet.add(spliced);
        } else {
          const [, ...rest] = spliced;
          rangedQueue.unshift(...rest);
        }
      }

      const matchedAccountIds = [...matchedTupleSet].flatMap((e) =>
        e.map((e) => e.accountId),
      );
      const batch = await tx.gameQueue.deleteMany({
        where: { accountId: { in: matchedAccountIds } },
      });
      void batch.count;

      return matchedTupleSet;
    });

    for (const matchedTuple of matchedTupleSet) {
      const game = await this.service.createNewRoom(
        {
          ...GameMatchmaker.params,
        },
        true,
      );
      for (const matched of matchedTuple) {
        const invitation = await this.makeInvitation(
          matched.accountId,
          matched.serverId,
          game.id,
        );
        this.server.uniqueActionForMatchmake(matched.accountId, (client) => {
          client.enqueued = false;
          client.closePosted = true;
          client.sendPayload(builder.makeInvitationPayload(invitation));
        });
      }
    }

    Logger.debug(
      `End matchmake. Matched ${matchedTupleSet.size} tuple(s).`,
      GameMatchmaker.name,
    );
  }

  async makeInvitationWithCreateNewRoom(
    accountId: string,
    params: GameRoomParams,
  ): Promise<string> {
    const game = await this.service.createNewRoom(params, false);

    return await this.makeInvitation(accountId, game.serverId, game.id);
  }

  async makeInvitationFromCode(
    accountId: string,
    code: string,
  ): Promise<string | null> {
    const game = await this.prisma.game.findUnique({ where: { code } });
    if (game === null) {
      return null;
    }

    return await this.makeInvitation(accountId, game.serverId, game.id);
  }

  async makeInvitationForResume(accountId: string): Promise<string | null> {
    const account = await this.prisma.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { game: true },
    });
    const game = account.game;
    if (game === null) {
      return null;
    }

    return await this.makeInvitation(accountId, game.serverId, game.id);
  }

  async makeInvitation(
    accountId: string,
    serverId: string,
    gameId: string,
    observer?: true | undefined,
  ): Promise<string> {
    const payload: GameInvitationPayload = {
      user_id: accountId,
      server_id: serverId,
      game_id: gameId,
      observer,
    };

    const invitation: string = await jwtSignatureHMAC(
      GameConfiguration.JWT_ALGORITHM,
      this.config.jwt_secret,
      payload,
      this.config.jwt_expire_secs,
      this.config.jwt_options,
    );

    return invitation;
  }
}
