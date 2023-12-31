export const enum GameServerOpcode {
  HANDSHAKE_GAME,
  SELECT_CHAR,
  SELECT_SPEC,
  CHANGE_TEAM,
  READY_STATE,

  SYNCHRONIZE_REQUEST = 0x80,
  RESYNCHRONIZE_RESULT,

  HANDSHAKE_MATCHMAKE = 0x100,
}

export const enum GameClientOpcode {
  GAME_ROOM,
  GAME_FAILED,
  ENTER_MEMBER,
  UPDATE_MEMBER,
  LEAVE_MEMBER,
  UPDATE_GAME,
  GAME_RESULT,
  ACHIEVEMENT,

  SYNCHRONIZE_RESULT = 0x80,
  RESYNCHRONIZE_REQUEST,

  ENQUEUED = 0x100,
  INVITATION,
  MATCHMAKE_FAILED,
}
