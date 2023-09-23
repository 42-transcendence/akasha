import { SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { ByteBuffer, NULL_UUID, assert } from "akasha-lib";
import { ServerOptions } from "ws";
import { ServiceGatewayBase } from "@/service/service-gateway";
import { verifyClientViaQueryParam } from "@/service/ws-verify-client";
import { ChatService } from "./chat.service";
import { ChatWebSocket } from "./chat-websocket";
import { ChatServerOpcode } from "@common/chat-opcodes";
import {
  ChatRoomChatMessagePairEntry,
  FriendModifyFlags,
  ChatErrorNumber,
  RoomModifyFlags,
  SocialErrorNumber,
  fromChatRoomModeFlags,
  readChatRoomChatMessagePair,
  ReportErrorNumber,
  FriendActiveFlags,
} from "@common/chat-payloads";
import { PacketHackException } from "@/service/packet-hack-exception";
import {
  CHAT_ROOM_TITLE_REGEX,
  MAX_CHAT_MEMBER_CAPACITY,
} from "@common/chat-constants";
import * as builder from "./chat-payload-builder";
import { ChatServer } from "./chat.server";
import { ActiveStatusNumber, Role, RoleNumber } from "@common/generated/types";
import { NICK_NAME_REGEX } from "@common/profile-constants";

function validatePasswordHash(value: string): boolean {
  /* NOTE: bcrypt
  if (!value.startsWith("$")) {
    return false;
  }

  const [algorithm, costStr, saltAndHash] = value.substring(1).split("$", 3);
  if (algorithm !== CHAT_PASSWORD_BCRYPT_ALGORITHM) {
    return false;
  }

  const cost = Number(costStr);
  if (!Number.isSafeInteger(cost) || cost < 0 || cost >= 32) {
    return false;
  }
  if (cost !== CHAT_PASSWORD_BCRYPT_LOG_ROUNDS) {
    return false;
  }

  if (saltAndHash.length !== 22 + 31) {
    return false;
  }

  const salt = saltAndHash.substring(0, 22);
  if (salt !== CHAT_PASSWORD_BCRYPT_SALT) {
    return false;
  }

  const hash = saltAndHash.substring(22);
  void hash;

  return true;
  */

  return value.length === 44;
}

@WebSocketGateway<ServerOptions>({
  path: "/chat",
  verifyClient: verifyClientViaQueryParam("token"),
  WebSocket: ChatWebSocket,
  clientTracking: false, //NOTE: `clientTracking=true`라면 애플리케이션이 종료되기 직전 정리 작업에서 모든 웹소켓이 닫힐때까지 기다렸다가 서버의 close Promise가 resolve되고 종료된다. false로 설정하면 정리 작업에서 서버의 close Promise가 즉시 resolve되어 종료되며, 애플리케이션이 종료되면서 모든 웹소켓의 상대편이 강제로 끊기게 된다.
})
export class ChatGateway extends ServiceGatewayBase<ChatWebSocket> {
  constructor(
    private readonly server: ChatServer,
    private readonly chatService: ChatService,
  ) {
    super();
  }

  override async handleServiceConnection(client: ChatWebSocket): Promise<void> {
    await this.server.trackClientTemporary(client);
    client.injectProviders(this.server, this.chatService);
  }

  override async handleServiceDisconnect(client: ChatWebSocket): Promise<void> {
    await this.server.untrackClient(client);
  }

  private assertClient(value: unknown, message: string): asserts value {
    if (!value) {
      throw new PacketHackException(message);
    }
  }

  @SubscribeMessage(ChatServerOpcode.HANDSHAKE)
  async handleHandshake(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(!client.handshakeState, "Duplicate handshake");
    await this.server.trackClient(client);

    const fetchedMessageIdPairs: ChatRoomChatMessagePairEntry[] =
      payload.readArray(readChatRoomChatMessagePair);
    const fetchedMessageIdPairsDirect: ChatRoomChatMessagePairEntry[] =
      payload.readArray(readChatRoomChatMessagePair);

    const init = await this.chatService.loadInitializePayload(
      client.accountId,
      fetchedMessageIdPairs,
      fetchedMessageIdPairsDirect,
    );

    return builder.makeInitializePayload(
      init.chatRoomList,
      init.chatMessageMap,
      init.directRoomList,
      init.directMessageMap,
      init.socialPayload,
    );
  }

  @SubscribeMessage(ChatServerOpcode.ACTIVE_STATUS_MANUAL)
  async handleActiveStatus(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const activeStatus = payload.read1();
    switch (activeStatus) {
      case ActiveStatusNumber.ONLINE:
      case ActiveStatusNumber.IDLE:
      case ActiveStatusNumber.DO_NOT_DISTURB:
      case ActiveStatusNumber.INVISIBLE:
        break;
      default:
        throw new PacketHackException(
          `Illegal active status [${activeStatus}]`,
        );
    }

    const prevInvisible = await this.chatService.isInvisible(client.accountId);
    if (
      await this.chatService.setActiveStatus(client.accountId, activeStatus)
    ) {
      const invisible = await this.chatService.isInvisible(client.accountId);
      let activeFlags = FriendActiveFlags.SHOW_ACTIVE_STATUS;
      if (prevInvisible !== invisible) {
        await this.chatService.setActiveTimestamp(client.accountId);
        activeFlags |= FriendActiveFlags.SHOW_ACTIVE_TIMESTAMP;
      }
      this.server.notifyActiveStatus(client.accountId, activeFlags);
    }
  }

  @SubscribeMessage(ChatServerOpcode.IDLE_AUTO)
  async handleIdleAuto(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const idle = payload.readBoolean();

    client.socketActiveStatus = idle
      ? ActiveStatusNumber.IDLE
      : ActiveStatusNumber.ONLINE;
    const invisible = await this.chatService.isInvisible(client.accountId);
    this.server.notifyActiveStatus(
      client.accountId,
      FriendActiveFlags.SHOW_ACTIVE_STATUS,
      !invisible,
    );
  }

  @SubscribeMessage(ChatServerOpcode.STATUS_MESSAGE)
  async handleStatusMessage(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const statusMessage = payload.readString();

    await this.chatService.setStatusMessage(client.accountId, statusMessage);
    this.server.notifyActiveStatus(
      client.accountId,
      FriendActiveFlags.SHOW_STATUS_MESSAGE,
    );
  }

  @SubscribeMessage(ChatServerOpcode.ADD_FRIEND)
  async handleAddFriend(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const lookup = payload.readBoolean();
    let targetAccountId: string | null;
    if (lookup) {
      const targetNickName = payload.readString();
      if (!NICK_NAME_REGEX.test(targetNickName)) {
        throw new PacketHackException(
          `Illegal targetNickName [${targetNickName}]`,
        );
      }
      const targetNickTag = payload.read4Unsigned();
      targetAccountId = await this.chatService.getAccountIdByNick(
        targetNickName,
        targetNickTag,
      );
    } else {
      targetAccountId = payload.readUUID();
    }
    const groupName = payload.readString();
    const activeFlags = payload.read1();

    const result = await this.chatService.addFriend(
      client.accountId,
      targetAccountId,
      groupName,
      activeFlags,
    );
    if (result.errno !== SocialErrorNumber.SUCCESS) {
      return builder.makeAddFriendFailedResult(result.errno);
    }
    assert(targetAccountId !== null);
    const { friend } = result;
    if (
      await this.chatService.isDuplexFriend(client.accountId, targetAccountId)
    ) {
      void this.server.unicast(
        targetAccountId,
        builder.makeUpdateFriendActiveStatus(client.accountId),
      );
    } else {
      void this.server.unicast(
        targetAccountId,
        builder.makeFriendRequest(client.accountId),
      );
    }
    void this.server.unicast(
      client.accountId,
      builder.makeAddFriendSuccessResult(friend),
    );

    return undefined;
  }

  @SubscribeMessage(ChatServerOpcode.MODIFY_FRIEND)
  async handleModifyFriend(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const targetAccountId = payload.readUUID();
    const modifyFlags = payload.read1();
    let groupName: string | undefined;
    if ((modifyFlags & FriendModifyFlags.MODIFY_GROUP_NAME) !== 0) {
      groupName = payload.readString();
    }
    let activeFlags: number | undefined;
    if ((modifyFlags & FriendModifyFlags.MODIFY_ACTIVE_FLAGS) !== 0) {
      activeFlags = payload.read1();
    }
    if (groupName === undefined && activeFlags === undefined) {
      throw new PacketHackException(`Illegal modifyFlags [${modifyFlags}]`);
    }

    const result = await this.chatService.modifyFriend(
      client.accountId,
      targetAccountId,
      groupName,
      activeFlags,
    );
    if (result.errno !== SocialErrorNumber.SUCCESS) {
      return builder.makeModifyFriendFailedResult(result.errno);
    }
    const { friend } = result;
    void this.server.unicast(
      targetAccountId,
      builder.makeUpdateFriendActiveStatus(client.accountId),
    );
    void this.server.unicast(
      client.accountId,
      builder.makeModifyFriendSuccessResult(targetAccountId, friend),
    );

    return undefined;
  }

  @SubscribeMessage(ChatServerOpcode.DELETE_FRIEND)
  async handleDeleteFriend(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const targetAccountId = payload.readUUID();

    const [errno, forward, reverse] = await this.chatService.deleteFriend(
      client.accountId,
      targetAccountId,
    );
    if (errno !== SocialErrorNumber.SUCCESS) {
      return builder.makeDeleteFriendFailedResult(errno);
    }
    assert(forward !== undefined || reverse !== undefined);
    void this.server.unicast(
      targetAccountId,
      builder.makeDeleteFriendSuccessResult(
        client.accountId,
        reverse === undefined,
      ),
    );
    void this.server.unicast(
      client.accountId,
      builder.makeDeleteFriendSuccessResult(
        targetAccountId,
        forward === undefined,
      ),
    );

    return undefined;
  }

  @SubscribeMessage(ChatServerOpcode.ADD_ENEMY)
  async handleAddEnemy(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const lookup = payload.readBoolean();
    let targetAccountId: string | null;
    if (lookup) {
      const targetNickName = payload.readString();
      if (!NICK_NAME_REGEX.test(targetNickName)) {
        throw new PacketHackException(
          `Illegal targetNickName [${targetNickName}]`,
        );
      }
      const targetNickTag = payload.read4Unsigned();
      targetAccountId = await this.chatService.getAccountIdByNick(
        targetNickName,
        targetNickTag,
      );
    } else {
      targetAccountId = payload.readUUID();
    }
    const memo = payload.readString();

    const result = await this.chatService.addEnemy(
      client.accountId,
      targetAccountId,
      memo,
    );
    if (result.errno !== SocialErrorNumber.SUCCESS) {
      return builder.makeAddEnemyFailedResult(result.errno);
    }
    assert(targetAccountId !== null);
    const { enemy } = result;
    void this.server.unicast(
      client.accountId,
      builder.makeAddEnemySuccessResult(enemy),
    );

    return undefined;
  }

  @SubscribeMessage(ChatServerOpcode.MODIFY_ENEMY)
  async handleModifyEnemy(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const targetAccountId = payload.readUUID();
    const memo = payload.readString();

    const result = await this.chatService.modifyEnemy(
      client.accountId,
      targetAccountId,
      memo,
    );
    if (result.errno !== SocialErrorNumber.SUCCESS) {
      return builder.makeModifyEnemyFailedResult(result.errno);
    }
    const { enemy } = result;
    void this.server.unicast(
      client.accountId,
      builder.makeModifyEnemySuccessResult(targetAccountId, enemy),
    );

    return undefined;
  }

  @SubscribeMessage(ChatServerOpcode.DELETE_ENEMY)
  async handleDeleteEnemy(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const targetAccountId = payload.readUUID();

    const [errno, forward] = await this.chatService.deleteEnemy(
      client.accountId,
      targetAccountId,
    );
    if (errno !== SocialErrorNumber.SUCCESS) {
      return builder.makeDeleteEnemyFailedResult(errno);
    }
    assert(forward !== undefined);
    void this.server.unicast(
      client.accountId,
      builder.makeDeleteEnemySuccessResult(targetAccountId),
    );

    return undefined;
  }

  @SubscribeMessage(ChatServerOpcode.PUBLIC_ROOM_LIST_REQUEST)
  async handlePublicRoomListRequest(client: ChatWebSocket) {
    this.assertClient(client.handshakeState, "Invalid state");

    const chatRoomViewList = await this.chatService.loadPublicRoomList();

    return builder.makePublicRoomList(chatRoomViewList);
  }

  @SubscribeMessage(ChatServerOpcode.CREATE_ROOM)
  async handleCreateRoom(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const title = payload.readString();
    if (!CHAT_ROOM_TITLE_REGEX.test(title)) {
      throw new PacketHackException(`Illegal title [${title}]`);
    }
    const modeFlags = fromChatRoomModeFlags(payload.read1());
    let password: string = "";
    if (modeFlags.isSecret) {
      password = payload.readString();
      if (!validatePasswordHash(password)) {
        throw new PacketHackException(`Illegal password [${password}]`);
      }
    }
    const limit = payload.read2Unsigned();
    if (limit == 0 || limit > MAX_CHAT_MEMBER_CAPACITY) {
      throw new PacketHackException(`Illegal limit [${limit}]`);
    }
    const targetAccountIdList = payload.readArray(payload.readUUID);
    if (targetAccountIdList.length > limit) {
      throw new PacketHackException(
        `Exceed limit [${limit}], member count [${targetAccountIdList.length}]`,
      );
    }

    const ownerAccountId = client.accountId;
    if (!targetAccountIdList.includes(ownerAccountId)) {
      throw new PacketHackException(`Member without owner`);
    }
    const ownerDuplexFriendSet = new Set<string>(
      (await this.chatService.getDuplexFriends(ownerAccountId)).map(
        (e) => e.friendAccountId,
      ),
    );
    const ownerSimplexEnemySet =
      await this.chatService.getSimplexEnemies(ownerAccountId);
    const memberAccountIdList = targetAccountIdList.filter(
      (e) =>
        e === ownerAccountId ||
        (ownerDuplexFriendSet.has(e) && !ownerSimplexEnemySet.has(e)),
    );

    const result = await this.chatService.createNewRoom(
      ownerAccountId,
      {
        title,
        ...modeFlags,
        password,
        limit,
      },
      memberAccountIdList.map((e) => ({
        accountId: e,
        role: e === ownerAccountId ? Role.ADMINISTRATOR : Role.USER,
      })),
    );

    let chatId: string = NULL_UUID;
    if (result.errno === ChatErrorNumber.SUCCESS) {
      const { room } = result;
      chatId = room.id;
      const messages = await this.chatService.loadMessagesAfter(
        chatId,
        undefined,
      );
      void this.server.multicastToRoom(
        chatId,
        builder.makeInsertRoom(room, messages),
      );

      void this.server.sendNotice(
        chatId,
        ownerAccountId,
        new URLSearchParams([
          ["type", "create"],
          ["title", title],
          ["member", ownerAccountId],
        ]).toString(),
      );
    }

    return builder.makeCreateRoomResult(result.errno, chatId);
  }

  @SubscribeMessage(ChatServerOpcode.ENTER_ROOM)
  async handleEnterRoom(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const chatId = payload.readUUID();
    const password = payload.readString();
    if (password !== "") {
      if (!validatePasswordHash(password)) {
        throw new PacketHackException(`Illegal password [${password}]`);
      }
    }

    const result = await this.chatService.enterRoom(
      chatId,
      client.accountId,
      password,
    );
    if (result.errno === ChatErrorNumber.SUCCESS) {
      const { room, member } = result;
      const messages = await this.chatService.loadMessagesAfter(
        room.id,
        undefined,
      );
      void this.server.unicast(
        member.accountId,
        builder.makeInsertRoom(room, messages),
      );
      void this.server.multicastToRoom(
        room.id,
        builder.makeInsertRoomMember(room.id, member),
        member.accountId,
      );

      void this.server.sendNotice(
        room.id,
        member.accountId,
        new URLSearchParams([
          ["type", "enter"],
          ["member", member.accountId],
        ]).toString(),
      );
    }

    if (result.errno === ChatErrorNumber.ERROR_CHAT_BANNED) {
      assert(result.bans !== null);
      return builder.makeEnterRoomFailedCauseBanned(chatId, result.bans);
    }
    return builder.makeEnterRoomResult(result.errno, chatId);
  }

  @SubscribeMessage(ChatServerOpcode.LEAVE_ROOM)
  async handleLeaveRoom(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const chatId = payload.readUUID();
    const result = await this.chatService.leaveRoom(chatId, client.accountId);
    if (result.errno === ChatErrorNumber.SUCCESS) {
      const { chatId, accountId } = result;
      client.sendPayload(builder.makeLeaveRoomResult(result.errno, chatId));
      void this.server.unicast(
        client.accountId,
        builder.makeRemoveRoom(chatId),
      );
      void this.server.multicastToRoom(
        chatId,
        builder.makeRemoveRoomMember(chatId, accountId),
      );

      void this.server.sendNotice(
        chatId,
        accountId,
        new URLSearchParams([
          ["type", "leave"],
          ["member", accountId],
        ]).toString(),
      );

      //NOTE: Already sent
      return undefined;
    }

    return builder.makeLeaveRoomResult(result.errno, chatId);
  }

  @SubscribeMessage(ChatServerOpcode.INVITE_USER)
  async handleInviteUser(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const chatId = payload.readUUID();
    const targetAccountId = payload.readUUID();

    const result = await this.chatService.inviteRoomMember(
      chatId,
      client.accountId,
      targetAccountId,
    );
    if (result.errno === ChatErrorNumber.SUCCESS) {
      const { room, member } = result;
      const messages = await this.chatService.loadMessagesAfter(
        room.id,
        undefined,
      );
      void this.server.unicast(
        member.accountId,
        builder.makeInsertRoom(room, messages),
      );
      void this.server.multicastToRoom(
        room.id,
        builder.makeInsertRoomMember(room.id, member),
        member.accountId,
      );

      void this.server.sendNotice(
        room.id,
        member.accountId,
        new URLSearchParams([
          ["type", "invite"],
          ["member", member.accountId],
          ["source", client.accountId],
        ]).toString(),
      );
    }

    return builder.makeInviteRoomResult(result.errno, chatId, targetAccountId);
  }

  @SubscribeMessage(ChatServerOpcode.SEND_MESSAGE)
  async handleSendMessage(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const chatId = payload.readUUID();
    const content = payload.readString();

    const result = await this.chatService.trySendMessage(
      chatId,
      client.accountId,
      content,
    );
    if (result.errno === ChatErrorNumber.ERROR_CHAT_BANNED) {
      assert(result.bans !== null);
      return builder.makeSendMessageFailedCauseBanned(chatId, result.bans);
    }
    if (result.errno === ChatErrorNumber.SUCCESS) {
      const { message } = result;
      void this.server.multicastToRoom(
        chatId,
        builder.makeChatMessagePayload(message),
      );
    }

    return builder.makeSendMessageResult(result.errno, chatId);
  }

  @SubscribeMessage(ChatServerOpcode.SYNC_CURSOR)
  async handleSyncCursor(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const pair = readChatRoomChatMessagePair(payload);

    await this.chatService.updateLastMessageCursor(client.accountId, pair);
    void this.server.unicast(
      client.accountId,
      builder.makeSyncCursorPayload(pair),
      client,
    );
  }

  @SubscribeMessage(ChatServerOpcode.CHANGE_ROOM_PROPERTY)
  async handleChangeRoomProperty(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const chatId = payload.readUUID();
    const modifyFlags = payload.read1();
    let title: string | undefined;
    if ((modifyFlags & RoomModifyFlags.MODIFY_TITLE) !== 0) {
      title = payload.readString();
      if (!CHAT_ROOM_TITLE_REGEX.test(title)) {
        throw new PacketHackException(`Illegal title [${title}]`);
      }
    }
    let modeFlags: ReturnType<typeof fromChatRoomModeFlags> | undefined;
    if ((modifyFlags & RoomModifyFlags.MODIFY_MODE_FLAGS) !== 0) {
      modeFlags = fromChatRoomModeFlags(payload.read1());
    }
    let password: string | undefined;
    if ((modifyFlags & RoomModifyFlags.MODIFY_PASSWORD) !== 0) {
      password = payload.readString();
      if (password !== "") {
        if (!validatePasswordHash(password)) {
          throw new PacketHackException(`Illegal password [${password}]`);
        }
      }
    }
    let limit: number | undefined;
    if ((modifyFlags & RoomModifyFlags.MODIFY_LIMIT) !== 0) {
      limit = payload.read2Unsigned();
      if (limit == 0 || limit > MAX_CHAT_MEMBER_CAPACITY) {
        throw new PacketHackException(`Illegal limit [${limit}]`);
      }
    }
    if (
      title === undefined &&
      modeFlags === undefined &&
      password === undefined &&
      limit === undefined
    ) {
      throw new PacketHackException(`Illegal modifyFlags [${modifyFlags}]`);
    }

    const result = await this.chatService.updateRoom(chatId, client.accountId, {
      title,
      ...modeFlags,
      password,
      limit,
    });
    if (result.errno === ChatErrorNumber.SUCCESS) {
      const { room } = result;
      void this.server.multicastToRoom(chatId, builder.makeUpdateRoom(room));

      if (title !== undefined) {
        void this.server.sendNotice(
          chatId,
          client.accountId,
          new URLSearchParams([
            ["type", "update"],
            ["title", title],
            ["member", client.accountId],
          ]).toString(),
        );
      }
    }

    return builder.makeChangeRoomPropertyResult(result.errno, chatId);
  }

  @SubscribeMessage(ChatServerOpcode.CHANGE_MEMBER_ROLE)
  async handleChangeMemberRole(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const chatId = payload.readUUID();
    const targetAccountId = payload.readUUID();
    const targetRole = payload.read1();
    if (targetRole !== RoleNumber.USER && targetRole !== RoleNumber.MANAGER) {
      throw new PacketHackException(`Illegal targetRole [${targetRole}]`);
    }

    const result = await this.chatService.changeMemberRole(
      chatId,
      client.accountId,
      targetAccountId,
      targetRole,
    );
    if (result.errno === ChatErrorNumber.SUCCESS) {
      const { chatId, member } = result;
      void this.server.multicastToRoom(
        chatId,
        builder.makeUpdateRoomMember(chatId, member),
      );

      void this.server.sendNotice(
        chatId,
        client.accountId,
        new URLSearchParams([
          ["type", member.role === RoleNumber.MANAGER ? "promote" : "demote"],
          ["member", member.accountId],
          ["source", client.accountId],
        ]).toString(),
      );
    }

    return builder.makeChangeMemberRoleResult(
      result.errno,
      chatId,
      targetAccountId,
      targetRole,
    );
  }

  @SubscribeMessage(ChatServerOpcode.HANDOVER_ROOM_OWNER)
  async handleHandoverRoomOwner(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const chatId = payload.readUUID();
    const targetAccountId = payload.readUUID();

    const result = await this.chatService.changeAdministrator(
      chatId,
      client.accountId,
      targetAccountId,
    );
    if (result.errno === ChatErrorNumber.SUCCESS) {
      const { chatId, members } = result;
      for (const member of members) {
        void this.server.multicastToRoom(
          chatId,
          builder.makeUpdateRoomMember(chatId, member),
        );
      }

      void this.server.sendNotice(
        chatId,
        client.accountId,
        new URLSearchParams([
          ["type", "handover"],
          ["member", targetAccountId],
          ["source", client.accountId],
        ]).toString(),
      );
    }

    return builder.makeHandoverRoomOwnerResult(
      result.errno,
      chatId,
      targetAccountId,
    );
  }

  @SubscribeMessage(ChatServerOpcode.KICK_MEMBER)
  async handleKickMember(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const chatId = payload.readUUID();
    const targetAccountId = payload.readUUID();
    const reason = payload.readString();
    const memo = payload.readString();
    const timespanSecs = payload.readNullable(payload.read4Unsigned);

    const result = await this.chatService.kickRoomMember(
      chatId,
      client.accountId,
      targetAccountId,
      reason,
      memo,
      timespanSecs,
    );
    if (result.errno === ChatErrorNumber.SUCCESS) {
      const { chatId, accountId, banId, ban } = result;
      void this.server.unicast(accountId, builder.makeKickNotify(chatId, ban));
      void this.server.unicast(accountId, builder.makeRemoveRoom(chatId));
      void this.server.multicastToRoom(
        chatId,
        builder.makeRemoveRoomMember(chatId, accountId),
      );

      void this.server.sendNotice(
        chatId,
        client.accountId,
        new URLSearchParams([
          ["type", "kick"],
          ["member", accountId],
          ["source", client.accountId],
          ["ban", banId],
        ]).toString(),
      );
    }

    return builder.makeKickMemberResult(result.errno, chatId, targetAccountId);
  }

  @SubscribeMessage(ChatServerOpcode.MUTE_MEMBER)
  async handleMuteMember(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const chatId = payload.readUUID();
    const targetAccountId = payload.readUUID();
    const reason = payload.readString();
    const memo = payload.readString();
    const timespanSecs = payload.readNullable(payload.read4Unsigned);

    const result = await this.chatService.muteRoomMember(
      chatId,
      client.accountId,
      targetAccountId,
      reason,
      memo,
      timespanSecs,
    );
    if (result.errno === ChatErrorNumber.SUCCESS) {
      const { chatId, accountId, banId, ban } = result;
      void this.server.unicast(accountId, builder.makeMuteNotify(chatId, ban));

      void this.server.sendNotice(
        chatId,
        client.accountId,
        new URLSearchParams([
          ["type", "mute"],
          ["member", accountId],
          ["source", client.accountId],
          ["ban", banId],
        ]).toString(),
      );
    }

    return builder.makeMuteMemberResult(result.errno, chatId, targetAccountId);
  }

  @SubscribeMessage(ChatServerOpcode.BAN_LIST_REQUEST)
  async handleBanListRequest(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const chatId = payload.readUUID();

    if (!(await this.chatService.isManager(chatId, client.accountId))) {
      return undefined;
    }

    const bans = await this.chatService.getChatBannedForManager(chatId);

    return builder.makeBanList(bans);
  }

  @SubscribeMessage(ChatServerOpcode.UNBAN_MEMBER)
  async handleUnbanMember(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const banId = payload.readString();

    const result = await this.chatService.unbanMember(client.accountId, banId);
    if (result.errno === ChatErrorNumber.SUCCESS) {
      const { chatId, accountId, ban } = result;

      void this.server.sendNotice(
        chatId,
        client.accountId,
        new URLSearchParams([
          ["type", "unban"],
          ["member", accountId],
          ["source", client.accountId],
          ["ban", banId],
          ["ban[expire]", ban.expireTimestamp?.toString() ?? "__PERMANENT__"],
        ]).toString(),
      );
    }

    return builder.makeUnbanMemberResult(result.errno, banId);
  }

  @SubscribeMessage(ChatServerOpcode.DESTROY_ROOM)
  async handleDestroyRoom(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const chatId = payload.readUUID();

    const result = await this.chatService.removeRoom(chatId, client.accountId);
    if (result.errno === ChatErrorNumber.SUCCESS) {
      const { chatId, accountId } = result;
      client.sendPayload(builder.makeDestroyRoomResult(result.errno, chatId));
      void this.server.unicast(accountId, builder.makeRemoveRoom(chatId));

      //NOTE: Already sent
      return undefined;
    }

    return builder.makeDestroyRoomResult(result.errno, chatId);
  }

  @SubscribeMessage(ChatServerOpcode.SYNC_CURSOR_DIRECT)
  async handleSyncCursorDirect(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const pair = readChatRoomChatMessagePair(payload);

    await this.chatService.updateLastDirectCursor(client.accountId, pair);
    void this.server.unicast(
      client.accountId,
      builder.makeSyncCursorDirectPayload(pair),
      client,
    );
  }

  @SubscribeMessage(ChatServerOpcode.SEND_DIRECT)
  async handleSendDirect(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const targetAccountId = payload.readUUID();
    const content = payload.readString();

    const result = await this.chatService.trySendDirect(
      client.accountId,
      targetAccountId,
      content,
    );
    if (result.errno === ChatErrorNumber.SUCCESS) {
      const { message } = result;
      void this.server.unicast(
        client.accountId,
        builder.makeChatDirectPayload(targetAccountId, message),
      );
      void this.server.unicast(
        targetAccountId,
        builder.makeChatDirectPayload(client.accountId, message),
      );
    }

    return builder.makeSendDirectResult(result.errno, targetAccountId);
  }

  @SubscribeMessage(ChatServerOpcode.REPORT_USER)
  async handleReportUser(client: ChatWebSocket, payload: ByteBuffer) {
    this.assertClient(client.handshakeState, "Invalid state");

    const targetAccountId = payload.readUUID();
    const reason = payload.readString();

    const result = await this.chatService.reportUser(
      client.accountId,
      targetAccountId,
      reason,
    );
    if (result.errno === ReportErrorNumber.SUCCESS) {
      // const { reportId, targetAccountId } = result;
      //TODO: 신고 관리 및 운영 기능
    }

    return builder.makeReportUserResult(result.errno, targetAccountId);
  }
}
