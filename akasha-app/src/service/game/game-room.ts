import { Logger } from "@nestjs/common";
import { ByteBuffer } from "akasha-lib";
import {
  GameProgress,
  GameEarnScore,
  GameStatistics,
  GameMemberStatistics,
  GameRoomParams,
  GameMemberParams,
} from "@common/game-payloads";
import { GameEntity } from "@common/generated/types";
import { GameServer } from "./game.server";
import { GameService } from "./game.service";
import * as builder from "./game-payload-builder";
import * as Glicko from "./game-rating";

export class GameRoom {
  readonly defaultMaxSet = 3;
  readonly defaultTimespan = 10 * 60 * 1000;
  readonly initialProgress = () => ({
    score: [0, 0],
    initialStartTime: Date.now(),
    totalTimespan: this.defaultTimespan,
    suspended: false,
    resumedTime: Date.now(),
    consumedTimespanSum: 0,
    resumeScheduleTime: null,
  });
  readonly defaultRestTime = 4000;
  readonly maxScore = 7;

  private updaterId: ReturnType<typeof setTimeout>;
  readonly members = new Map<string, GameMember>();
  readonly createdTimestamp = Date.now();
  unused = true;
  firstAllReady = 0;
  progress: GameProgress | undefined;
  earnScoreList = Array<GameEarnScore>();
  statistics: GameStatistics = { setProgress: [] };
  memberStatistics: GameMemberStatistics[] = [];
  initialRatings = new Map<string, Glicko.Rating>();

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
  ): void {
    this.unused = false;
    const member = new GameMember(
      this,
      accountId,
      skillRating,
      ratingDeviation,
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
    const count_0 = values.filter((e) => e.team === 0).length;
    const count_1 = values.filter((e) => e.team === 1).length;
    return count_0 <= count_1 ? 0 : 1;
  }

  allReady(): boolean {
    const values = [...this.members.values()];
    const allReady = values.every((e) => e.ready);
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
              await this.finalEnd();
            } else {
              const values = [...this.members.values()];
              const count_0 = values.filter((e) => e.team === 0).length;
              const count_1 = values.filter((e) => e.team === 1).length;
              if (count_0 === 0 || count_1 === 0) {
                await this.finalEnd();
              } else {
                if (
                  progress.score[0] >= this.maxScore ||
                  progress.score[1] >= this.maxScore
                ) {
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
    this.initialRatings = await this.service.getRatingMap([
      ...this.members.keys(),
    ]);
    this.progress = {
      currentSet: 0,
      maxSet: this.defaultMaxSet,
      ...this.initialProgress(),
      suspended: true,
      resumeScheduleTime: Date.now() + this.defaultRestTime,
    };
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
    this.progress.score[team] += value;
    this.sendUpdateRoom();
  }

  nextSet() {
    if (this.progress === undefined) {
      return;
    }
    this.statistics.setProgress ??= [];
    this.statistics.setProgress.push({
      progress: this.progress,
      earnScore: this.earnScoreList,
    });
    this.progress = {
      ...this.progress,
      ...this.initialProgress(),
      currentSet: this.progress.currentSet + 1,
      suspended: true,
      resumeScheduleTime: Date.now() + this.defaultRestTime,
    };
    this.earnScoreList = [];
    this.sendUpdateRoom();
  }

  stop() {
    if (this.progress === undefined) {
      return;
    }
    if (this.progress.suspended) {
      return;
    }
    this.progress.suspended = true;
    this.progress.consumedTimespanSum += Date.now() - this.progress.resumedTime;
    this.progress.resumeScheduleTime = null;
    this.sendUpdateRoom();
  }

  async finalEnd() {
    if (this.progress === undefined) {
      return;
    }
    const incompleted = this.progress.currentSet < this.progress.maxSet;
    //TODO: record
    if (!incompleted && this.ladder) {
      //TODO: skillRating
    }
    //TODO: history
    this.broadcast(builder.makeGameResult());
    this.progress = undefined;
    this.sendUpdateRoom();
    this.dispose();
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
