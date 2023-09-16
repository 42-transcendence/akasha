import { GameClientOpcode } from "@common/game-opcodes";
import {
  GameProgress,
  GameRoomEnterResult,
  GameRoomParams,
  MatchmakeFailedReason,
  writeGameMemberParams,
  writeGameProgress,
  writeGameRoomParams,
  writeGameRoomProps,
} from "@common/game-payloads";
import { ByteBuffer } from "akasha-lib";
import { GameMember, GameRoom } from "./game-room";

export function makeEnqueuedAlert(params: GameRoomParams) {
  const buf = ByteBuffer.createWithOpcode(GameClientOpcode.ENQUEUED);
  writeGameRoomParams(params, buf);
  return buf;
}

export function makeInvitationPayload(invitation: string) {
  const buf = ByteBuffer.createWithOpcode(GameClientOpcode.INVITATION);
  buf.writeString(invitation);
  return buf;
}

export function makeMatchmakeFailed(reason: MatchmakeFailedReason) {
  const buf = ByteBuffer.createWithOpcode(GameClientOpcode.MATCHMAKE_FAILED);
  buf.write1(reason);
  return buf;
}

export function makeGameRoom(room: GameRoom) {
  const buf = ByteBuffer.createWithOpcode(GameClientOpcode.GAME_ROOM);
  writeGameRoomProps(room.props, buf);
  writeGameRoomParams(room.params, buf);
  buf.writeLength(room.members.size);
  for (const [, member] of room.members) {
    writeGameMemberParams(member, buf);
  }
  buf.writeBoolean(room.ladder);
  return buf;
}

export function makeGameFailedPayload(errno: GameRoomEnterResult) {
  const buf = ByteBuffer.createWithOpcode(GameClientOpcode.GAME_FAILED);
  buf.write1(errno);
  return buf;
}

export function makeEnterMember(member: GameMember) {
  const buf = ByteBuffer.createWithOpcode(GameClientOpcode.ENTER_MEMBER);
  writeGameMemberParams(member, buf);
  return buf;
}

export function makeUpdateMember(accountId: string, member: GameMember) {
  const buf = ByteBuffer.createWithOpcode(GameClientOpcode.UPDATE_MEMBER);
  writeGameMemberParams({ ...member, accountId }, buf);
  return buf;
}

export function makeLeaveMember(accountId: string) {
  const buf = ByteBuffer.createWithOpcode(GameClientOpcode.LEAVE_MEMBER);
  buf.writeUUID(accountId);
  return buf;
}

export function makeUpdateGame(progress: GameProgress | undefined) {
  const buf = ByteBuffer.createWithOpcode(GameClientOpcode.UPDATE_GAME);
  buf.writeNullable(progress ?? null, writeGameProgress);
  return buf;
}

export function makeGameResult() {
  const buf = ByteBuffer.createWithOpcode(GameClientOpcode.GAME_RESULT);
  //FIXME: 작성
  return buf;
}

export function makeAchievement(accountId: string, achievementId: number) {
  const buf = ByteBuffer.createWithOpcode(GameClientOpcode.ACHIEVEMENT);
  buf.writeUUID(accountId);
  buf.write2Unsigned(achievementId);
  return buf;
}

//TODO: SYNCHRONIZE,
