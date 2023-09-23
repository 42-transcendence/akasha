import { Logger } from "@nestjs/common";
import { ByteBuffer } from "akasha-lib";
import {
  GameProgress,
  GameEarnScore,
  GameStatistics,
  GameMemberStatistics,
  GameRoomParams,
  GameMemberParams,
  GameOutcome,
} from "@common/game-payloads";
import { GameEntity } from "@common/generated/types";
import { GameServer } from "./game.server";
import { GameService } from "./game.service";
import * as builder from "./game-payload-builder";
import * as Glicko from "./game-rating";

export class GameRoom {
  readonly defaultMaxSet = 3;
  readonly defaultTimespan = 10 * 60 * 1000;
  readonly initialProgress = {
    totalTimespan: this.defaultTimespan,
    suspended: false,
    consumedTimespanSum: 0,
    resumeScheduleTime: null,
  };
  readonly defaultRestTime = 4000;
  readonly maxScore = 7;

  private updaterId: ReturnType<typeof setTimeout>;
  readonly members = new Map<string, GameMember>();
  readonly createdTimestamp = Date.now();
  unused = true;
  firstAllReady = 0;
  progress: GameProgress | undefined;
  earnScoreList = Array<GameEarnScore>();
  progresseStatistics = Array<GameProgress>();
  earnScoreStatistics = Array<Array<GameEarnScore>>();
  initialTimestamp = new Date();
  initialTeams = new Map<string, number>();
  initialRatings: Map<string, Glicko.Rating> | undefined;

  constructor(
    readonly service: GameService,
    readonly server: GameServer,
    readonly props: GameEntity,
    readonly params: GameRoomParams,
    readonly ladder: boolean,
  ) {
    this.updaterId = this.registerUpdate(500);
  }

  addMember(
    accountId: string,
    skillRating: number,
    ratingDeviation: number,
    ratingVolatility: number,
  ): void {
    this.unused = false;
    const member = new GameMember(
      this,
      accountId,
      skillRating,
      ratingDeviation,
      ratingVolatility,
    );
    this.members.set(accountId, member);
    this.server.uniqueAction(accountId, (client) => {
      client.gameId = this.props.id;
      client.sendPayload(builder.makeGameRoom(this));
    });
    this.broadcast(builder.makeEnterMember(member), accountId);
  }

  updateMember(accountId: string, action: (member: GameMember) => void): void {
    const member: GameMember | undefined = this.members.get(accountId);
    if (member !== undefined) {
      action(member);
      this.broadcast(builder.makeUpdateMember(accountId, member));
    }
  }

  removeMember(accountId: string): void {
    this.server.uniqueAction(accountId, (client) => {
      client.gameId = undefined;
      client.closePosted = true;
    });
    if (this.members.delete(accountId)) {
      this.broadcast(builder.makeLeaveMember(accountId));
    }
  }

  nextTeam(): number {
    const values = [...this.members.values()];
    //FIXME: 2개팀 전제
    const count_0 = values.filter((e) => e.team === 0).length;
    const count_1 = values.filter((e) => e.team === 1).length;
    return count_0 <= count_1 ? 0 : 1;
  }

  allReady(): boolean {
    const values = [...this.members.values()];
    const allReady = values.every((e) => e.ready);
    //FIXME: 2개팀 전제
    const count_0 = values.filter((e) => e.team === 0).length;
    const count_1 = values.filter((e) => e.team === 1).length;
    return allReady && count_0 === count_1;
  }

  broadcast(buf: ByteBuffer, except?: string | undefined): void {
    for (const [key] of this.members) {
      if (key !== except) {
        this.server.unicast(key, buf);
      }
    }
  }

  private registerUpdate(delay: number) {
    return setTimeout(() => {
      this.update()
        .then(() => {
          this.updaterId = this.registerUpdate(delay);
        })
        .catch((e) => {
          Logger.error(`Failed update rooms: ${e}`, GameRoom.name);
        });
    }, delay);
  }

  async update(): Promise<void> {
    const progress = this.progress;
    if (progress === undefined) {
      if (this.ladder) {
        if (this.members.size >= this.params.limit) {
          await this.initialStart();
        }
      } else {
        if (this.members.size > 1 && this.allReady()) {
          if (this.firstAllReady === 0) {
            this.firstAllReady = Date.now();
          } else if (this.firstAllReady + this.defaultRestTime >= Date.now()) {
            await this.initialStart();
          }
        } else {
          if (this.firstAllReady !== 0) {
            this.firstAllReady = 0;
          }
        }
      }
    } else {
      //TODO: Exclude over-suspended users from the game
      if (progress.currentSet < progress.maxSet) {
        if (progress.suspended) {
          if (progress.resumeScheduleTime !== null) {
            if (progress.resumeScheduleTime < Date.now()) {
              this.start();
            }
          }
        } else {
          if (
            progress.resumedTime +
              progress.totalTimespan -
              progress.consumedTimespanSum <
            Date.now()
          ) {
            this.nextSet();
          } else {
            if (this.members.size <= 1) {
              await this.giveUp();
            } else {
              const values = [...this.members.values()];
              //FIXME: 2개팀 전제
              const count_0 = values.filter((e) => e.team === 0).length;
              const count_1 = values.filter((e) => e.team === 1).length;
              if (count_0 === 0 || count_1 === 0) {
                await this.giveUp();
              } else {
                //FIXME: 2개팀 전제
                const score_0 = progress.score[0];
                const score_1 = progress.score[1];
                if (score_0 >= this.maxScore || score_1 >= this.maxScore) {
                  this.nextSet();
                }
              }
            }
          }
        }
      } else {
        await this.finalEnd();
      }
    }
  }

  async initialStart() {
    this.initialTimestamp = new Date();
    this.initialTeams = [...this.members].reduce(
      (map, [key, val]) => map.set(key, val.team),
      new Map<string, number>(),
    );
    if (this.ladder) {
      this.initialRatings = [...this.members].reduce(
        (map, [key, val]) =>
          map.set(key, {
            sr: val.skillRating,
            rd: val.ratingDeviation,
            rv: val.ratingVolatility,
          }),
        new Map<string, Glicko.Rating>(),
      );
    }
    this.progress = {
      ...this.initialProgress,
      currentSet: 0,
      score: [0, 0], //FIXME: 2개팀 전제
      maxSet: this.defaultMaxSet,
      initialStartTime: Date.now(),
      suspended: true,
      resumedTime: Date.now(),
      resumeScheduleTime: Date.now() + this.defaultRestTime,
    };
    this.sendUpdateRoom();
  }

  earnScore(accountId: string, team: number, value: number = 1) {
    if (this.progress === undefined) {
      return;
    }
    this.earnScoreList.push({
      accountId,
      team,
      value,
      timestamp: new Date(),
    });
    this.progress.suspended = true;
    this.progress.consumedTimespanSum += Date.now() - this.progress.resumedTime;
    this.progress.resumeScheduleTime = Date.now() + this.defaultRestTime;
    this.progress.score[team] += value;
    this.sendUpdateRoom();
  }

  nextSet() {
    if (this.progress === undefined) {
      return;
    }
    // Stop
    this.progress.suspended = true;
    this.progress.consumedTimespanSum += Date.now() - this.progress.resumedTime;
    this.progress.resumeScheduleTime = null;

    // Save
    this.progresseStatistics.push(this.progress);
    this.earnScoreStatistics.push(this.earnScoreList);

    // Initialize
    this.progress = {
      ...this.progress,
      ...this.initialProgress,
      currentSet: this.progress.currentSet + 1,
      score: [0, 0], //FIXME: 2개팀 전제
      initialStartTime: Date.now(),
      suspended: true,
      resumedTime: Date.now(),
      resumeScheduleTime: Date.now() + this.defaultRestTime,
    };
    this.earnScoreList = [];

    this.sendUpdateRoom();
  }

  start() {
    if (this.progress === undefined) {
      return;
    }
    if (!this.progress.suspended) {
      return;
    }
    this.progress.suspended = false;
    this.progress.resumedTime = Date.now();
    this.progress.resumeScheduleTime = null;
    this.sendUpdateRoom();
  }

  stop() {
    if (this.progress === undefined) {
      return;
    }
    if (this.progress.suspended) {
      return;
    }
    // Stop
    this.progress.suspended = true;
    this.progress.consumedTimespanSum += Date.now() - this.progress.resumedTime;
    this.progress.resumeScheduleTime = null;
    this.sendUpdateRoom();
  }

  async giveUp() {
    if (this.progress === undefined) {
      return;
    }
    // Stop
    this.progress.suspended = true;
    this.progress.consumedTimespanSum += Date.now() - this.progress.resumedTime;
    this.progress.resumeScheduleTime = null;

    // Save
    this.progresseStatistics.push(this.progress);
    this.earnScoreStatistics.push(this.earnScoreList);

    await this.finalEnd();
  }

  static getOutcomeValue(outcome: GameOutcome): number {
    //FIXME: 세트 점수 미사용 전제
    switch (outcome) {
      case GameOutcome.WIN:
        return 1;
      case GameOutcome.LOSE:
        return 0;
      case GameOutcome.TIE:
        return 0.5;
      case GameOutcome.NONE:
        return 0;
    }
  }

  async finalEnd() {
    if (this.progress === undefined) {
      return;
    }
    const incompleted = this.progress.currentSet < this.progress.maxSet;
    const finalTeams = [...this.members].reduce(
      (map, [key, val]) => map.set(key, val.team),
      new Map<string, number>(),
    );
    //FIXME: 2개팀 전제
    let totalScore_0 = 0;
    let totalScore_1 = 0;
    for (const progress of this.progresseStatistics) {
      //FIXME: 2개팀 전제
      const score_0 = progress.score[0];
      const score_1 = progress.score[1];

      if (score_0 > score_1) {
        totalScore_0++;
      } else if (score_0 < score_1) {
        totalScore_1++;
      }
    }
    const outcomeMap = new Map<number, GameOutcome>();
    //FIXME: 2개팀 전제
    if (totalScore_0 > totalScore_1) {
      outcomeMap.set(0, GameOutcome.WIN);
      outcomeMap.set(1, GameOutcome.LOSE);
    } else if (totalScore_0 < totalScore_1) {
      outcomeMap.set(0, GameOutcome.LOSE);
      outcomeMap.set(1, GameOutcome.WIN);
    } else {
      outcomeMap.set(0, GameOutcome.TIE);
      outcomeMap.set(1, GameOutcome.TIE);
    }
    let finalRatings: Map<string, Glicko.Rating> | undefined;
    if (!incompleted && this.initialRatings !== undefined) {
      finalRatings = new Map<string, Glicko.Rating>();
      for (const [accountId, rating] of this.initialRatings) {
        const team = this.initialTeams.get(accountId);
        if (team === undefined) {
          continue;
        }
        const opponents = [...this.initialRatings]
          .filter(([key]) => key !== accountId)
          .map(([, val]) => {
            const { rv, ...rest } = val;
            void rv;
            const outcomeValue = GameRoom.getOutcomeValue(
              outcomeMap.get(team) ?? GameOutcome.NONE, //FIXME: 특정 상대에 대한 승리 여부가 아님
            );
            return { ...rest, s: outcomeValue };
          });
        finalRatings.set(accountId, Glicko.apply(rating, opponents)); //FIXME: 충분한 표본이 모이지 않았음에도 점수 변동을 즉시 적용
      }
    }
    // Collect statistics
    const statistics: GameStatistics = {
      gameId: this.props.id,
      params: this.params,
      ladder: this.ladder,
      timestamp: this.initialTimestamp,
      progresses: this.progresseStatistics,
      earnScores: this.earnScoreStatistics,
    };
    const memberStatistics = Array<GameMemberStatistics>();
    for (const [accountId, team] of this.initialTeams) {
      const initRating = this.initialRatings?.get(accountId);
      const finalRating = finalRatings?.get(accountId);
      memberStatistics.push({
        accountId,
        team,
        final: finalTeams.has(accountId),
        outcome: outcomeMap.get(team) ?? GameOutcome.NONE,
        ...(initRating !== undefined
          ? {
              initialSkillRating: initRating.sr,
              initialRatingDeviation: initRating.rd * Glicko.FIXED_POINT_RATIO,
              initialRatingVolatility: initRating.rv * Glicko.FIXED_POINT_RATIO,
            }
          : undefined),
        ...(finalRating !== undefined
          ? {
              finalSkillRating: finalRating.sr,
              finalRatingDeviation: finalRating.rd * Glicko.FIXED_POINT_RATIO,
              finalRatingVolatility: finalRating.rv * Glicko.FIXED_POINT_RATIO,
            }
          : undefined),
      });
    }
    await this.service.saveGameResult(statistics, memberStatistics);
    this.broadcast(builder.makeGameResult(statistics, memberStatistics));
    this.progress = undefined;
    this.sendUpdateRoom();
    await this.dispose();
  }

  sendUpdateRoom() {
    this.broadcast(builder.makeUpdateGame(this.progress));
  }

  async dispose(): Promise<void> {
    clearTimeout(this.updaterId);
    for (const [key] of this.members) {
      this.server.uniqueAction(key, (client) => {
        client.gameId = undefined;
        client.closePosted = true;
      });
    }
    this.members.clear();
    await this.service.removeRoom(this.props.id);
  }
}

export class GameMember implements GameMemberParams {
  character = 0;
  specification = 0;
  team: number;
  ready = false;

  constructor(
    readonly room: GameRoom,
    readonly accountId: string,
    readonly skillRating: number,
    readonly ratingDeviation: number,
    readonly ratingVolatility: number,
  ) {
    this.team = this.room.nextTeam();
  }

  accomplish(achievementId: number): void {
    this.room.service
      .accomplishAchievement(this.accountId, achievementId)
      .then(() =>
        this.room.broadcast(
          builder.makeAchievement(this.accountId, achievementId),
        ),
      )
      .catch(() => {
        //NOTE: ignore
      });
  }
}
