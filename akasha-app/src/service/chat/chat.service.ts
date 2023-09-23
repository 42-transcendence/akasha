import {
  PrismaService,
  PrismaTransactionClient,
} from "@/prisma/prisma.service";
import { Injectable, Logger } from "@nestjs/common";
import {
  ChatBanDetailEntry,
  ChatBanSummaryEntry,
  ChatMessageEntry,
  ChatRoomChatMessagePairEntry,
  ChatRoomEntry,
  ChatRoomMemberEntry,
  ChatRoomViewEntry,
  EnemyEntry,
  FRIEND_ACTIVE_FLAGS_SIZE,
  FriendEntry,
  ChatErrorNumber,
  SocialErrorNumber,
  SocialPayload,
  ChatDirectEntry,
  ReportErrorNumber,
} from "@common/chat-payloads";
import { AccountsService } from "@/user/accounts/accounts.service";
import {
  ActiveStatus,
  BanCategory,
  Chat,
  ChatBan,
  ChatDirect,
  ChatMember,
  ChatMessage,
  Enemy,
  Friend,
  Prisma,
  Role,
} from "@prisma/client";
import {
  ActiveStatusNumber,
  MessageTypeNumber,
  RoleNumber,
  getActiveStatusFromNumber,
  getBanCategoryNumber,
  getMessageTypeFromNumber,
  getMessageTypeNumber,
  getRoleFromNumber,
  getRoleNumber,
} from "@common/generated/types";
import { fromBitsString, toBitsString } from "akasha-lib";
import { getRoleLevel } from "@common/auth-payloads";

/// FriendForEntry
function toFriendEntry(friend: Friend): FriendEntry {
  return {
    ...friend,
    activeFlags: fromBitsString(friend.activeFlags, FRIEND_ACTIVE_FLAGS_SIZE),
  };
}

/// ChatMemberForEntry
const chatMemberForEntry = Prisma.validator<Prisma.ChatMemberDefaultArgs>()({
  select: {
    accountId: true,
    role: true,
  },
});
type ChatMemberForEntry = Prisma.ChatMemberGetPayload<
  typeof chatMemberForEntry
>;

function toChatMemberEntry(member: ChatMemberForEntry): ChatRoomMemberEntry {
  return {
    ...member,
    role: getRoleNumber(member.role),
  };
}

/// ChatRoomForEntry
const chatRoomForEntry = Prisma.validator<Prisma.ChatDefaultArgs>()({
  include: {
    members: chatMemberForEntry,
  },
});
type ChatRoomForEntry = Prisma.ChatGetPayload<typeof chatRoomForEntry>;

function toChatRoomEntry(
  chat: ChatRoomForEntry,
  lastMessageId: string | null = null,
): ChatRoomEntry {
  return {
    ...chat,
    members: chat.members.map((e) => toChatMemberEntry(e)),
    lastMessageId: lastMessageId,
  };
}

/// ChatRoomForViewEntry
const chatRoomForViewEntry = Prisma.validator<Prisma.ChatDefaultArgs>()({
  include: { members: { select: { chatId: true, accountId: true } } },
});
type ChatRoomForViewEntry = Prisma.ChatGetPayload<typeof chatRoomForViewEntry>;

function toChatRoomViewEntry(chat: ChatRoomForViewEntry): ChatRoomViewEntry {
  return {
    ...chat,
    memberCount: chat.members.length,
  };
}

/// ChatMemberWithRoom
const chatMemberWithRoom = Prisma.validator<Prisma.ChatMemberDefaultArgs>()({
  include: {
    chat: chatRoomForEntry,
  },
});
type ChatMemberWithRoom = Prisma.ChatMemberGetPayload<
  typeof chatMemberWithRoom
>;

/// MessageForEntry
function toChatMessage(message: ChatMessage): ChatMessageEntry {
  return {
    ...message,
    messageType: getMessageTypeNumber(message.messageType),
  };
}

function toChatMessageFromDirect(
  targetAccountId: string,
  direct: ChatDirect,
): ChatMessageEntry {
  return {
    ...direct,
    chatId: targetAccountId,
    accountId: direct.sourceAccountId,
    messageType: getMessageTypeNumber(direct.messageType),
  };
}

/// BanForEntry
function toBanSummaryEntry(ban: ChatBan): ChatBanSummaryEntry {
  return {
    ...ban,
    category: getBanCategoryNumber(ban.category),
  };
}

function toBanDetailEntry(ban: ChatBan): ChatBanDetailEntry {
  return {
    ...ban,
    category: getBanCategoryNumber(ban.category),
  };
}

/// FriendResult
type FriendResult =
  | { errno: SocialErrorNumber.SUCCESS; friend: FriendEntry }
  | { errno: Exclude<SocialErrorNumber, SocialErrorNumber.SUCCESS> };

/// EnemyResult
type EnemyResult =
  | { errno: SocialErrorNumber.SUCCESS; enemy: EnemyEntry }
  | { errno: Exclude<SocialErrorNumber, SocialErrorNumber.SUCCESS> };

/// ChatRoomFailed
type ChatRoomFailed =
  | {
      errno: Exclude<
        ChatErrorNumber,
        ChatErrorNumber.SUCCESS | ChatErrorNumber.ERROR_CHAT_BANNED
      >;
    }
  | {
      errno: ChatErrorNumber.ERROR_CHAT_BANNED;
      bans: ChatBanSummaryEntry[] | null;
    };

/// ChatCreateRoomResult
type ChatCreateRoomResult =
  | { errno: ChatErrorNumber.SUCCESS; room: ChatRoomEntry }
  | ChatRoomFailed;

/// ChatEnterRoomResult
type ChatEnterRoomResult =
  | {
      errno: ChatErrorNumber.SUCCESS;
      room: ChatRoomEntry;
      member: ChatRoomMemberEntry;
    }
  | ChatRoomFailed;

/// ChatLeaveRoomResult
type ChatLeaveRoomResult =
  | {
      errno: ChatErrorNumber.SUCCESS;
      chatId: string;
      accountId: string;
    }
  | ChatRoomFailed;

/// ChatMessageResult
type ChatMessageResult =
  | {
      errno: ChatErrorNumber.SUCCESS;
      message: ChatMessageEntry;
    }
  | ChatRoomFailed;

/// ChatRoomResult
type ChatRoomResult =
  | {
      errno: ChatErrorNumber.SUCCESS;
      room: ChatRoomViewEntry;
    }
  | ChatRoomFailed;

/// ChatMemberResult
type ChatMemberResult =
  | {
      errno: ChatErrorNumber.SUCCESS;
      chatId: string;
      member: ChatRoomMemberEntry;
    }
  | ChatRoomFailed;

/// ChatMembersResult
type ChatMembersResult =
  | {
      errno: ChatErrorNumber.SUCCESS;
      chatId: string;
      members: ChatRoomMemberEntry[];
    }
  | ChatRoomFailed;

/// ChatBanResult
type ChatBanResult =
  | {
      errno: ChatErrorNumber.SUCCESS;
      chatId: string;
      accountId: string;
      banId: string;
      ban: ChatBanSummaryEntry;
    }
  | ChatRoomFailed;

/// ReportResult
type ReportResult =
  | {
      errno: ReportErrorNumber.SUCCESS;
      reportId: string;
      targetAccountId: string;
    }
  | { errno: Exclude<ReportErrorNumber, ReportErrorNumber.SUCCESS> };

@Injectable()
export class ChatService {
  protected static readonly logger = new Logger(ChatService.name);

  protected static logUnknownError(e: any) {
    if (e instanceof Error) {
      ChatService.logger.error(e.name);
      ChatService.logger.error(e.message, e.stack);
    } else {
      ChatService.logger.error(e);
    }
  }

  private readonly memberCache = new Map<string, Set<string> | null>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
  ) {}

  // forward
  async getAccountIdByNick(name: string, tag: number) {
    return this.accounts.findAccountIdByNick(name, tag);
  }

  async setActiveStatus(
    accountId: string,
    activeStatusNumber: ActiveStatusNumber,
  ): Promise<boolean> {
    const activeStatus = getActiveStatusFromNumber(activeStatusNumber);
    const prevActiveStatus = await this.accounts.findActiveStatus(accountId);
    if (prevActiveStatus !== activeStatus) {
      await this.accounts.updateActiveStatus(accountId, activeStatus);
      return true;
    }
    return false;
  }

  async setActiveTimestamp(accountId: string): Promise<void> {
    await this.accounts.updateActiveTimestamp(accountId);
  }

  async isInvisible(accountId: string): Promise<boolean> {
    const prevActiveStatus = await this.accounts.findActiveStatus(accountId);
    return prevActiveStatus === ActiveStatus.INVISIBLE;
  }

  async setStatusMessage(
    accountId: string,
    statusMessage: string,
  ): Promise<void> {
    await this.accounts.updateStatusMessage(accountId, statusMessage);
  }

  async loadInitializePayload(
    accountId: string,
    fetchedMessageIdPairs: ChatRoomChatMessagePairEntry[],
    fetchedMessageIdPairsDirect: ChatRoomChatMessagePairEntry[],
  ) {
    const chatRoomList: ChatRoomEntry[] =
      await this.loadJoinedRoomList(accountId);

    const fetchedMessageIdMap = fetchedMessageIdPairs.reduce(
      (map, e) => map.set(e.chatId, e.messageId),
      new Map<string, string>(),
    );
    const chatMessageMap = new Map<string, ChatMessageEntry[]>();
    for (const chatRoom of chatRoomList) {
      const chatId = chatRoom.id;
      chatMessageMap.set(
        chatId,
        await this.loadMessagesAfter(chatId, fetchedMessageIdMap.get(chatId)),
      );
    }

    const directRoomList: ChatDirectEntry[] =
      await this.loadDirectRoomList(accountId);

    const fetchedMessageIdMapDirect = fetchedMessageIdPairsDirect.reduce(
      (map, e) => map.set(e.chatId, e.messageId),
      new Map<string, string>(),
    );
    const directMessageMap = new Map<string, ChatMessageEntry[]>();
    for (const directRoom of directRoomList) {
      const targetAccountId = directRoom.targetAccountId;
      directMessageMap.set(
        targetAccountId,
        await this.loadDirectMessagesAfter(
          accountId,
          targetAccountId,
          fetchedMessageIdMapDirect.get(targetAccountId),
        ),
      );
    }

    const socialPayload: SocialPayload = await this.loadSocial(accountId);

    return {
      chatRoomList,
      chatMessageMap,
      directRoomList,
      directMessageMap,
      socialPayload,
    };
  }

  async loadSocial(accountId: string): Promise<SocialPayload> {
    const account = await this.prisma.account.findUniqueOrThrow({
      where: { id: accountId },
      select: {
        friends: true,
        friendReferences: {
          select: {
            accountId: true,
          },
        },
        enemies: {
          select: {
            enemyAccountId: true,
            memo: true,
          },
        },
      },
    });

    const friendList = account.friends.map((e) => toFriendEntry(e));

    const friendUUIDSet = new Set<string>(
      account.friends.map((e) => e.friendAccountId),
    );
    const friendRequestList = account.friendReferences
      .map((e) => e.accountId)
      .filter((e) => !friendUUIDSet.has(e));

    const enemyList = account.enemies;

    return { friendList, friendRequestList, enemyList };
  }

  async addFriend(
    accountId: string,
    targetAccountId: string | null,
    groupName: string,
    activeFlags: number,
  ): Promise<FriendResult> {
    if (targetAccountId === null) {
      return { errno: SocialErrorNumber.ERROR_LOOKUP_FAILED };
    }
    if (targetAccountId === accountId) {
      return { errno: SocialErrorNumber.ERROR_SELF };
    }
    if (await this.isSimplexEnemy(accountId, targetAccountId)) {
      return { errno: SocialErrorNumber.ERROR_DENIED };
    }

    let friend: Friend;
    try {
      friend = await this.prisma.friend.create({
        data: {
          accountId,
          friendAccountId: targetAccountId,
          groupName,
          activeFlags: toBitsString(activeFlags, FRIEND_ACTIVE_FLAGS_SIZE),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code === "P2002") {
          return { errno: SocialErrorNumber.ERROR_ALREADY_EXISTS };
        }
      }
      ChatService.logUnknownError(e);
      return { errno: SocialErrorNumber.ERROR_UNKNOWN };
    }
    return {
      errno: SocialErrorNumber.SUCCESS,
      friend: toFriendEntry(friend),
    };
  }

  async modifyFriend(
    accountId: string,
    friendAccountId: string,
    groupName: string | undefined,
    activeFlags: number | undefined,
  ): Promise<FriendResult> {
    let friend: Friend;
    try {
      friend = await this.prisma.friend.update({
        where: {
          accountId_friendAccountId: { accountId, friendAccountId },
        },
        data: {
          groupName,
          activeFlags:
            activeFlags !== undefined
              ? toBitsString(activeFlags, FRIEND_ACTIVE_FLAGS_SIZE)
              : undefined,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code === "P2025") {
          return { errno: SocialErrorNumber.ERROR_NOT_FOUND };
        }
      }
      ChatService.logUnknownError(e);
      return { errno: SocialErrorNumber.ERROR_UNKNOWN };
    }
    return {
      errno: SocialErrorNumber.SUCCESS,
      friend: toFriendEntry(friend),
    };
  }

  async deleteFriend(
    accountId: string,
    friendAccountId: string,
  ): Promise<
    [
      errno: SocialErrorNumber,
      forward: FriendEntry | undefined,
      reverse: FriendEntry | undefined,
    ]
  > {
    //XXX: Prisma가 DELETE RETURNING을 deleteMany에서 지원하지 않았음.
    //XXX: Prisma가 DeleteUniqueIfExists 따위를 지원하지 않았음.
    let data: [Friend | null, Friend | null, unknown];
    try {
      data = await this.prisma.$transaction([
        this.prisma.friend.findUnique({
          where: {
            accountId_friendAccountId: { accountId, friendAccountId },
          },
        }),
        this.prisma.friend.findUnique({
          where: {
            accountId_friendAccountId: {
              friendAccountId: accountId,
              accountId: friendAccountId,
            },
          },
        }),
        this.prisma.friend.deleteMany({
          where: {
            OR: [
              {
                accountId,
                friendAccountId,
              },
              {
                friendAccountId: accountId,
                accountId: friendAccountId,
              },
            ],
          },
        }),
      ]);
    } catch (e) {
      ChatService.logUnknownError(e);
      return [SocialErrorNumber.ERROR_UNKNOWN, undefined, undefined];
    }
    const [forward, reverse] = data;
    if (forward === null && reverse === null) {
      return [SocialErrorNumber.ERROR_NOT_FOUND, undefined, undefined];
    }
    return [
      SocialErrorNumber.SUCCESS,
      forward !== null ? toFriendEntry(forward) : undefined,
      reverse !== null ? toFriendEntry(reverse) : undefined,
    ];
  }

  async isDuplexFriend(
    accountId: string,
    friendAccountId: string,
    tx?: PrismaTransactionClient | undefined,
  ): Promise<boolean> {
    tx ??= this.prisma;
    const account = await tx.account.findUnique({
      where: { id: accountId },
      select: {
        _count: {
          select: {
            friends: { where: { friendAccountId } },
            friendReferences: { where: { accountId: friendAccountId } },
          },
        },
      },
    });
    return (
      account !== null &&
      account._count.friends !== 0 &&
      account._count.friendReferences !== 0
    );
  }

  async getDuplexFriends(
    accountId: string,
    tx?: PrismaTransactionClient | undefined,
  ): Promise<FriendEntry[]> {
    tx ??= this.prisma;
    const account = await tx.account.findUniqueOrThrow({
      where: { id: accountId },
      select: {
        friends: true,
        friendReferences: { select: { accountId: true } },
      },
    });

    const reverses = new Set<string>(
      account.friendReferences.map((e) => e.accountId),
    );

    return account.friends
      .filter((e) => reverses.has(e.friendAccountId))
      .map((e) => toFriendEntry(e));
  }

  async addEnemy(
    accountId: string,
    targetAccountId: string | null,
    memo: string,
  ): Promise<EnemyResult> {
    if (targetAccountId === null) {
      return { errno: SocialErrorNumber.ERROR_LOOKUP_FAILED };
    }
    if (targetAccountId === accountId) {
      return { errno: SocialErrorNumber.ERROR_SELF };
    }

    let enemy: Enemy;
    try {
      enemy = await this.prisma.enemy.create({
        data: {
          accountId,
          enemyAccountId: targetAccountId,
          memo,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code === "P2002") {
          return { errno: SocialErrorNumber.ERROR_ALREADY_EXISTS };
        }
      }
      ChatService.logUnknownError(e);
      return { errno: SocialErrorNumber.ERROR_UNKNOWN };
    }
    return {
      errno: SocialErrorNumber.SUCCESS,
      enemy,
    };
  }

  async modifyEnemy(
    accountId: string,
    enemyAccountId: string,
    memo: string | undefined,
  ): Promise<EnemyResult> {
    let enemy: Enemy;
    try {
      enemy = await this.prisma.enemy.update({
        where: {
          accountId_enemyAccountId: { accountId, enemyAccountId },
        },
        data: {
          memo,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code === "P2025") {
          return { errno: SocialErrorNumber.ERROR_NOT_FOUND };
        }
      }
      ChatService.logUnknownError(e);
      return { errno: SocialErrorNumber.ERROR_UNKNOWN };
    }
    return {
      errno: SocialErrorNumber.SUCCESS,
      enemy,
    };
  }

  async deleteEnemy(
    accountId: string,
    enemyAccountId: string,
  ): Promise<[SocialErrorNumber, EnemyEntry | undefined]> {
    //XXX: Prisma가 DELETE RETURNING을 deleteMany에서 지원하지 않았음.
    //XXX: Prisma가 DeleteUniqueIfExists 따위를 지원하지 않았음.
    let data: [Enemy | null, unknown];
    try {
      data = await this.prisma.$transaction([
        this.prisma.enemy.findUnique({
          where: {
            accountId_enemyAccountId: { accountId, enemyAccountId },
          },
        }),
        this.prisma.enemy.deleteMany({
          where: { accountId, enemyAccountId },
        }),
      ]);
    } catch (e) {
      ChatService.logUnknownError(e);
      return [SocialErrorNumber.ERROR_UNKNOWN, undefined];
    }
    const [forward] = data;
    if (forward === null) {
      return [SocialErrorNumber.ERROR_NOT_FOUND, undefined];
    }
    return [SocialErrorNumber.SUCCESS, forward !== null ? forward : undefined];
  }

  async isSimplexEnemy(
    accountId: string,
    enemyAccountId: string,
    tx?: PrismaTransactionClient | undefined,
  ): Promise<boolean> {
    tx ??= this.prisma;
    const account = await tx.account.findUnique({
      where: { id: accountId },
      select: {
        _count: {
          select: {
            enemies: { where: { enemyAccountId } },
            enemyReferences: { where: { accountId: enemyAccountId } },
          },
        },
      },
    });
    return (
      account !== null &&
      (account._count.enemies !== 0 || account._count.enemyReferences !== 0)
    );
  }

  async getSimplexEnemies(
    accountId: string,
    tx?: PrismaTransactionClient | undefined,
  ): Promise<Set<string>> {
    tx ??= this.prisma;
    const account = await tx.account.findUniqueOrThrow({
      where: { id: accountId },
      select: {
        enemies: { select: { enemyAccountId: true } },
        enemyReferences: { select: { accountId: true } },
      },
    });

    const forwards = account.enemies.map((e) => e.enemyAccountId);
    const reverses = account.enemyReferences.map((e) => e.accountId);

    return new Set<string>([...forwards, ...reverses]);
  }

  async loadJoinedRoomList(accountId: string): Promise<ChatRoomEntry[]> {
    const members = await this.prisma.chatMember.findMany({
      where: { accountId },
      select: {
        chat: chatRoomForEntry,
        lastMessageId: true,
      },
    });

    return members.map((e) => toChatRoomEntry(e.chat, e.lastMessageId));
  }

  async loadMessagesAfter(
    chatId: string,
    lastMessageId: string | undefined,
  ): Promise<ChatMessageEntry[]> {
    const messages = await this.prisma.chatMessage.findMany({
      where: { chatId },
      orderBy: { timestamp: Prisma.SortOrder.asc },
      ...(lastMessageId !== undefined
        ? {
            skip: 1,
            cursor: { id: lastMessageId },
          }
        : undefined),
    });

    return messages.map((e) => toChatMessage(e));
  }

  async loadDirectRoomList(accountId: string): Promise<ChatDirectEntry[]> {
    return this.prisma.$transaction(async (tx) => {
      const rooms = await tx.chatDirect.groupBy({
        by: [
          Prisma.ChatDirectScalarFieldEnum.sourceAccountId,
          Prisma.ChatDirectScalarFieldEnum.destinationAccountId,
        ],
        where: {
          OR: [
            { sourceAccountId: accountId },
            { destinationAccountId: accountId },
          ],
        },
      });

      const targetAccountIdSet = new Set<string>(
        rooms.map((e) =>
          accountId === e.sourceAccountId
            ? e.destinationAccountId
            : e.sourceAccountId,
        ),
      );

      const result = Array<ChatDirectEntry>();
      for (const targetAccountId of targetAccountIdSet) {
        const message = await tx.chatDirect.findFirst({
          where: {
            OR: [
              {
                sourceAccountId: targetAccountId,
                destinationAccountId: accountId,
              },
              {
                sourceAccountId: accountId,
                destinationAccountId: targetAccountId,
              },
            ],
            isLastMessage: true,
          },
          orderBy: { timestamp: Prisma.SortOrder.desc },
          select: { id: true },
        });
        const lastMessageId = message?.id ?? null;
        result.push({ targetAccountId, lastMessageId });
      }

      return result;
    });
  }

  async loadDirectMessagesAfter(
    accountId: string,
    targetAccountId: string,
    lastMessageId: string | undefined,
  ): Promise<ChatMessageEntry[]> {
    const directs = await this.prisma.chatDirect.findMany({
      where: {
        OR: [
          { sourceAccountId: accountId, destinationAccountId: targetAccountId },
          { sourceAccountId: targetAccountId, destinationAccountId: accountId },
        ],
      },
      orderBy: { timestamp: Prisma.SortOrder.asc },
      ...(lastMessageId !== undefined
        ? {
            skip: 1,
            cursor: { id: lastMessageId },
          }
        : undefined),
    });

    return directs.map((e) => toChatMessageFromDirect(targetAccountId, e));
  }

  async loadPublicRoomList(): Promise<ChatRoomViewEntry[]> {
    const rooms = await this.prisma.chat.findMany({
      where: { isPrivate: false },
      ...chatRoomForViewEntry,
    });

    return rooms.map((e) => toChatRoomViewEntry(e));
  }

  async createNewRoom(
    ownerAccountId: string,
    roomOptions: Prisma.ChatCreateInput,
    members: Prisma.ChatMemberCreateManyChatInput[],
  ): Promise<ChatCreateRoomResult> {
    return this.prisma.$transaction(async (tx) => {
      const inspect = await this.prepareInspect(tx, ownerAccountId);
      if (inspect !== undefined) {
        return inspect;
      }

      let room: ChatRoomForEntry;
      try {
        room = await tx.chat.create({
          data: {
            ...roomOptions,
            members: {
              createMany: { data: members },
            },
          },
          include: {
            ...chatRoomForEntry.include,
            messages: true,
          },
        });
      } catch (e) {
        ChatService.logUnknownError(e);
        return { errno: ChatErrorNumber.ERROR_UNKNOWN };
      }

      const memberSet = new Set<string>(room.members.map((e) => e.accountId));
      this.memberCache.set(room.id, memberSet);

      return {
        errno: ChatErrorNumber.SUCCESS,
        room: toChatRoomEntry(room),
      };
    });
  }

  async enterRoom(
    chatId: string,
    accountId: string,
    password: string | null,
  ): Promise<ChatEnterRoomResult> {
    return this.prisma.$transaction(async (tx) => {
      const inspect = await this.prepareInspect(tx, accountId);
      if (inspect !== undefined) {
        return inspect;
      }

      const memberSet = await this.getChatMemberSet(chatId, tx);
      if (memberSet === null) {
        return { errno: ChatErrorNumber.ERROR_NO_ROOM };
      }
      if (memberSet.has(accountId)) {
        return { errno: ChatErrorNumber.ERROR_ALREADY_MEMBER };
      }

      const room = await tx.chat.findUniqueOrThrow({
        where: { id: chatId },
        select: {
          isPrivate: true,
          isSecret: true,
          password: true,
          limit: true,
        },
      });
      if (room.isPrivate) {
        return { errno: ChatErrorNumber.ERROR_RESTRICTED };
      }
      if (room.isSecret && password !== room.password) {
        return { errno: ChatErrorNumber.ERROR_WRONG_PASSWORD };
      }
      if (memberSet.size >= room.limit) {
        return { errno: ChatErrorNumber.ERROR_EXCEED_LIMIT };
      }

      const bans = await this.getChatBanned(
        chatId,
        accountId,
        BanCategory.ACCESS,
        tx,
      );
      if (bans.length !== 0) {
        return { errno: ChatErrorNumber.ERROR_CHAT_BANNED, bans };
      }

      return await this.insertChatMember(
        tx,
        chatId,
        accountId,
        RoleNumber.USER,
      );
    });
  }

  async leaveRoom(
    chatId: string,
    accountId: string,
  ): Promise<ChatLeaveRoomResult> {
    return this.prisma.$transaction(async (tx) => {
      const inspect = await this.prepareInspect(tx, accountId);
      if (inspect !== undefined) {
        return inspect;
      }

      const memberSet = await this.getChatMemberSet(chatId, tx);
      if (memberSet === null) {
        return { errno: ChatErrorNumber.ERROR_NO_ROOM };
      }
      if (!memberSet.has(accountId)) {
        return { errno: ChatErrorNumber.ERROR_UNJOINED };
      }

      const member = await tx.chatMember.findUniqueOrThrow({
        where: { chatId_accountId: { chatId, accountId } },
        select: { role: true },
      });
      if (member.role === Role.ADMINISTRATOR) {
        return { errno: ChatErrorNumber.ERROR_RESTRICTED };
      }

      return await this.deleteChatMember(tx, chatId, accountId);
    });
  }

  async inviteRoomMember(
    chatId: string,
    accountId: string,
    targetAccountId: string,
  ): Promise<ChatEnterRoomResult> {
    return this.prisma.$transaction(async (tx) => {
      const inspect = await this.prepareInspect(tx, accountId);
      if (inspect !== undefined) {
        return inspect;
      }

      const memberSet = await this.getChatMemberSet(chatId, tx);
      if (memberSet === null) {
        return { errno: ChatErrorNumber.ERROR_NO_ROOM };
      }
      if (!memberSet.has(accountId)) {
        return { errno: ChatErrorNumber.ERROR_UNJOINED };
      }
      if (memberSet.has(targetAccountId)) {
        return { errno: ChatErrorNumber.ERROR_ALREADY_MEMBER };
      }

      if (accountId === targetAccountId) {
        return { errno: ChatErrorNumber.ERROR_SELF };
      }
      if (!(await this.isDuplexFriend(accountId, targetAccountId, tx))) {
        return { errno: ChatErrorNumber.ERROR_NOT_FRIEND };
      }
      if (await this.isSimplexEnemy(accountId, targetAccountId, tx)) {
        return { errno: ChatErrorNumber.ERROR_ENEMY };
      }

      const room = await tx.chat.findUniqueOrThrow({
        where: { id: chatId },
        select: { isSecret: true, password: true, limit: true },
      });
      const member = await tx.chatMember.findUniqueOrThrow({
        where: { chatId_accountId: { chatId, accountId } },
        select: { role: true },
      });
      if (
        room.isSecret &&
        room.password !== "" &&
        getRoleLevel(member.role) < getRoleLevel(Role.MANAGER)
      ) {
        return { errno: ChatErrorNumber.ERROR_PERMISSION };
      }
      if (memberSet.size >= room.limit) {
        return { errno: ChatErrorNumber.ERROR_EXCEED_LIMIT };
      }

      const bans = await this.getChatBanned(
        chatId,
        targetAccountId,
        BanCategory.ACCESS,
        tx,
      );
      if (bans.length !== 0) {
        //NOTE: Do NOT with `bans`
        return { errno: ChatErrorNumber.ERROR_CHAT_BANNED, bans: null };
      }

      return await this.insertChatMember(
        tx,
        chatId,
        targetAccountId,
        RoleNumber.USER,
      );
    });
  }

  async muteRoomMember(
    chatId: string,
    accountId: string,
    targetAccountId: string,
    reason: string,
    memo: string,
    timespanSecs: number | null,
  ): Promise<ChatBanResult> {
    return this.prisma.$transaction(async (tx) => {
      const inspect = await this.prepareInspect(tx, accountId);
      if (inspect !== undefined) {
        return inspect;
      }

      const memberSet = await this.getChatMemberSet(chatId, tx);
      if (memberSet === null) {
        return { errno: ChatErrorNumber.ERROR_NO_ROOM };
      }
      if (!memberSet.has(accountId)) {
        return { errno: ChatErrorNumber.ERROR_UNJOINED };
      }
      if (!memberSet.has(targetAccountId)) {
        return { errno: ChatErrorNumber.ERROR_NO_MEMBER };
      }

      if (accountId === targetAccountId) {
        return { errno: ChatErrorNumber.ERROR_SELF };
      }

      const member = await tx.chatMember.findUniqueOrThrow({
        where: { chatId_accountId: { chatId, accountId } },
        select: { role: true },
      });
      if (getRoleLevel(member.role) < getRoleLevel(Role.MANAGER)) {
        return { errno: ChatErrorNumber.ERROR_PERMISSION };
      }
      const targetMember = await tx.chatMember.findUniqueOrThrow({
        where: { chatId_accountId: { chatId, accountId: targetAccountId } },
        select: { role: true },
      });
      if (getRoleLevel(member.role) < getRoleLevel(targetMember.role)) {
        return { errno: ChatErrorNumber.ERROR_RESTRICTED };
      }

      const ban = await tx.chatBan.create({
        data: {
          chatId,
          accountId: targetAccountId,
          managerAccountId: accountId,
          category: BanCategory.COMMIT,
          reason,
          memo,
          expireTimestamp:
            timespanSecs !== null
              ? new Date(Date.now() + timespanSecs * 1000)
              : null,
        },
      });
      return {
        errno: ChatErrorNumber.SUCCESS,
        chatId,
        accountId: targetAccountId,
        banId: ban.id,
        ban: toBanSummaryEntry(ban),
      };
    });
  }

  async kickRoomMember(
    chatId: string,
    accountId: string,
    targetAccountId: string,
    reason: string,
    memo: string,
    timespanSecs: number | null,
  ): Promise<ChatBanResult> {
    return this.prisma.$transaction(async (tx) => {
      const inspect = await this.prepareInspect(tx, accountId);
      if (inspect !== undefined) {
        return inspect;
      }

      const memberSet = await this.getChatMemberSet(chatId, tx);
      if (memberSet === null) {
        return { errno: ChatErrorNumber.ERROR_NO_ROOM };
      }
      if (!memberSet.has(accountId)) {
        return { errno: ChatErrorNumber.ERROR_UNJOINED };
      }
      if (!memberSet.has(targetAccountId)) {
        return { errno: ChatErrorNumber.ERROR_NO_MEMBER };
      }

      if (accountId === targetAccountId) {
        return { errno: ChatErrorNumber.ERROR_SELF };
      }

      const member = await tx.chatMember.findUniqueOrThrow({
        where: { chatId_accountId: { chatId, accountId } },
        select: { role: true },
      });
      if (getRoleLevel(member.role) < getRoleLevel(Role.MANAGER)) {
        return { errno: ChatErrorNumber.ERROR_PERMISSION };
      }
      const targetMember = await tx.chatMember.findUniqueOrThrow({
        where: { chatId_accountId: { chatId, accountId: targetAccountId } },
        select: { role: true },
      });
      if (getRoleLevel(member.role) < getRoleLevel(targetMember.role)) {
        return { errno: ChatErrorNumber.ERROR_RESTRICTED };
      }
      if (targetMember.role === Role.ADMINISTRATOR) {
        return { errno: ChatErrorNumber.ERROR_RESTRICTED };
      }

      const ban = await tx.chatBan.create({
        data: {
          chatId,
          accountId: targetAccountId,
          managerAccountId: accountId,
          category: BanCategory.ACCESS,
          reason,
          memo,
          expireTimestamp:
            timespanSecs !== null
              ? new Date(Date.now() + timespanSecs * 1000)
              : null,
        },
      });

      const result = await this.deleteChatMember(tx, chatId, targetAccountId);
      if (result.errno === ChatErrorNumber.SUCCESS) {
        return {
          ...result,
          banId: ban.id,
          ban: toBanSummaryEntry(ban),
        };
      }
      return result;
    });
  }

  async unbanMember(accountId: string, banId: string): Promise<ChatBanResult> {
    return this.prisma.$transaction(async (tx) => {
      const inspect = await this.prepareInspect(tx, accountId);
      if (inspect !== undefined) {
        return inspect;
      }

      const ban = await tx.chatBan.findUnique({ where: { id: banId } });
      if (ban === null) {
        return { errno: ChatErrorNumber.ERROR_UNKNOWN };
      }
      const {
        chatId,
        accountId: targetAccountId,
        managerAccountId,
        expireTimestamp,
      } = ban;
      if (expireTimestamp !== null && expireTimestamp.getTime() < Date.now()) {
        return { errno: ChatErrorNumber.ERROR_RESTRICTED };
      }

      const memberSet = await this.getChatMemberSet(chatId, tx);
      if (memberSet === null) {
        return { errno: ChatErrorNumber.ERROR_NO_ROOM };
      }
      if (!memberSet.has(accountId)) {
        return { errno: ChatErrorNumber.ERROR_UNJOINED };
      }

      if (accountId === targetAccountId) {
        return { errno: ChatErrorNumber.ERROR_SELF };
      }

      const member = await tx.chatMember.findUniqueOrThrow({
        where: { chatId_accountId: { chatId, accountId } },
        select: { role: true },
      });
      if (getRoleLevel(member.role) < getRoleLevel(Role.MANAGER)) {
        return { errno: ChatErrorNumber.ERROR_PERMISSION };
      }
      const managerMember = await tx.chatMember.findUniqueOrThrow({
        where: { chatId_accountId: { chatId, accountId: managerAccountId } },
        select: { role: true },
      });
      if (getRoleLevel(member.role) < getRoleLevel(managerMember.role)) {
        return { errno: ChatErrorNumber.ERROR_RESTRICTED };
      }

      //NOTE: Soft delete
      void (await tx.chatBan.update({
        where: { id: banId },
        data: { expireTimestamp: new Date() },
      }));

      return {
        errno: ChatErrorNumber.SUCCESS,
        chatId,
        accountId: targetAccountId,
        banId: ban.id,
        ban: toBanSummaryEntry(ban),
      };
    });
  }

  async updateRoom(
    chatId: string,
    accountId: string,
    roomOptions: Prisma.ChatUpdateInput,
  ): Promise<ChatRoomResult> {
    return this.prisma.$transaction(async (tx) => {
      const inspect = await this.prepareInspect(tx, accountId);
      if (inspect !== undefined) {
        return inspect;
      }

      const memberSet = await this.getChatMemberSet(chatId, tx);
      if (memberSet === null) {
        return { errno: ChatErrorNumber.ERROR_NO_ROOM };
      }
      if (!memberSet.has(accountId)) {
        return { errno: ChatErrorNumber.ERROR_UNJOINED };
      }

      const member = await tx.chatMember.findUniqueOrThrow({
        where: { chatId_accountId: { chatId, accountId } },
        select: { role: true },
      });
      if (getRoleLevel(member.role) < getRoleLevel(Role.MANAGER)) {
        return { errno: ChatErrorNumber.ERROR_PERMISSION };
      }

      let room: ChatRoomForViewEntry;
      try {
        room = await tx.chat.update({
          where: { id: chatId },
          data: roomOptions,
          ...chatRoomForViewEntry,
        });
      } catch (e) {
        ChatService.logUnknownError(e);
        return { errno: ChatErrorNumber.ERROR_UNKNOWN };
      }

      return {
        errno: ChatErrorNumber.SUCCESS,
        room: toChatRoomViewEntry(room),
      };
    });
  }

  async changeMemberRole(
    chatId: string,
    accountId: string,
    targetAccountId: string,
    role: RoleNumber,
  ): Promise<ChatMemberResult> {
    return this.prisma.$transaction(async (tx) => {
      const inspect = await this.prepareInspect(tx, accountId);
      if (inspect !== undefined) {
        return inspect;
      }

      const memberSet = await this.getChatMemberSet(chatId, tx);
      if (memberSet === null) {
        return { errno: ChatErrorNumber.ERROR_NO_ROOM };
      }
      if (!memberSet.has(accountId)) {
        return { errno: ChatErrorNumber.ERROR_UNJOINED };
      }
      if (!memberSet.has(targetAccountId)) {
        return { errno: ChatErrorNumber.ERROR_NO_MEMBER };
      }

      if (accountId === targetAccountId) {
        return { errno: ChatErrorNumber.ERROR_SELF };
      }

      const member = await tx.chatMember.findUniqueOrThrow({
        where: { chatId_accountId: { chatId, accountId } },
        select: { role: true },
      });
      if (getRoleLevel(member.role) < getRoleLevel(Role.ADMINISTRATOR)) {
        return { errno: ChatErrorNumber.ERROR_PERMISSION };
      }
      const targetMember = await tx.chatMember.findUniqueOrThrow({
        where: { chatId_accountId: { chatId, accountId: targetAccountId } },
        select: { role: true },
      });
      if (role === getRoleNumber(targetMember.role)) {
        return { errno: ChatErrorNumber.ERROR_RESTRICTED };
      }
      const updatedTargetMember = await tx.chatMember.update({
        where: { chatId_accountId: { chatId, accountId: targetAccountId } },
        data: { role: getRoleFromNumber(role) },
        select: { ...chatMemberForEntry.select, chatId: true },
      });

      return {
        errno: ChatErrorNumber.SUCCESS,
        chatId: updatedTargetMember.chatId,
        member: toChatMemberEntry(updatedTargetMember),
      };
    });
  }

  async changeAdministrator(
    chatId: string,
    accountId: string,
    targetAccountId: string,
  ): Promise<ChatMembersResult> {
    return this.prisma.$transaction(async (tx) => {
      const inspect = await this.prepareInspect(tx, accountId);
      if (inspect !== undefined) {
        return inspect;
      }

      const memberSet = await this.getChatMemberSet(chatId, tx);
      if (memberSet === null) {
        return { errno: ChatErrorNumber.ERROR_NO_ROOM };
      }
      if (!memberSet.has(accountId)) {
        return { errno: ChatErrorNumber.ERROR_UNJOINED };
      }
      if (!memberSet.has(targetAccountId)) {
        return { errno: ChatErrorNumber.ERROR_NO_MEMBER };
      }

      if (accountId === targetAccountId) {
        return { errno: ChatErrorNumber.ERROR_SELF };
      }

      const member = await tx.chatMember.findUniqueOrThrow({
        where: { chatId_accountId: { chatId, accountId } },
        select: { role: true },
      });
      if (getRoleLevel(member.role) < getRoleLevel(Role.ADMINISTRATOR)) {
        return { errno: ChatErrorNumber.ERROR_PERMISSION };
      }
      const targetMember = await tx.chatMember.findUniqueOrThrow({
        where: { chatId_accountId: { chatId, accountId: targetAccountId } },
        select: { role: true },
      });
      if (getRoleLevel(targetMember.role) < getRoleLevel(Role.MANAGER)) {
        return { errno: ChatErrorNumber.ERROR_RESTRICTED };
      }
      const updatedMember = await tx.chatMember.update({
        where: { chatId_accountId: { chatId, accountId } },
        data: { role: targetMember.role },
        ...chatMemberForEntry,
      });
      const updatedTargetMember = await tx.chatMember.update({
        where: { chatId_accountId: { chatId, accountId: targetAccountId } },
        data: { role: member.role },
        select: { ...chatMemberForEntry.select, chatId: true },
      });

      return {
        errno: ChatErrorNumber.SUCCESS,
        chatId: updatedTargetMember.chatId,
        members: [
          toChatMemberEntry(updatedMember),
          toChatMemberEntry(updatedTargetMember),
        ],
      };
    });
  }

  async removeRoom(
    chatId: string,
    accountId: string,
  ): Promise<ChatLeaveRoomResult> {
    return this.prisma.$transaction(async (tx) => {
      const inspect = await this.prepareInspect(tx, accountId);
      if (inspect !== undefined) {
        return inspect;
      }

      const memberSet = await this.getChatMemberSet(chatId, tx);
      if (memberSet === null) {
        return { errno: ChatErrorNumber.ERROR_NO_ROOM };
      }
      if (!memberSet.has(accountId)) {
        return { errno: ChatErrorNumber.ERROR_UNJOINED };
      }
      if (memberSet.size !== 1) {
        return { errno: ChatErrorNumber.ERROR_RESTRICTED };
      }

      const member = await tx.chatMember.findUniqueOrThrow({
        where: { chatId_accountId: { chatId, accountId } },
        select: { chatId: true, accountId: true, role: true },
      });
      if (getRoleLevel(member.role) < getRoleLevel(Role.ADMINISTRATOR)) {
        return { errno: ChatErrorNumber.ERROR_PERMISSION };
      }

      let room: Chat;
      try {
        room = await tx.chat.delete({ where: { id: member.chatId } });
        //NOTE: chat_members & chat_messages are expected to be deleted by `ON DELETE CASCADE`
      } catch (e) {
        ChatService.logUnknownError(e);
        return { errno: ChatErrorNumber.ERROR_UNKNOWN };
      }

      this.memberCache.set(room.id, null);

      return {
        errno: ChatErrorNumber.SUCCESS,
        chatId: room.id,
        accountId: member.accountId,
      };
    });
  }

  async trySendMessage(
    chatId: string,
    accountId: string,
    content: string,
  ): Promise<ChatMessageResult> {
    if (content === "") {
      return { errno: ChatErrorNumber.ERROR_RESTRICTED };
    }

    return this.prisma.$transaction(async (tx) => {
      const inspect = await this.prepareInspect(tx, accountId);
      if (inspect !== undefined) {
        return inspect;
      }

      const memberSet = await this.getChatMemberSet(chatId, tx);
      if (memberSet === null) {
        return { errno: ChatErrorNumber.ERROR_NO_ROOM };
      }
      if (!memberSet.has(accountId)) {
        return { errno: ChatErrorNumber.ERROR_UNJOINED };
      }

      const bans = await this.getChatBanned(
        chatId,
        accountId,
        BanCategory.COMMIT,
        tx,
      );
      if (bans.length !== 0) {
        return { errno: ChatErrorNumber.ERROR_CHAT_BANNED, bans };
      }

      const message = await this.createNewChatMessage(
        chatId,
        accountId,
        content,
        MessageTypeNumber.REGULAR,
      );
      if (message === null) {
        return { errno: ChatErrorNumber.ERROR_UNKNOWN };
      }
      return {
        errno: ChatErrorNumber.SUCCESS,
        message,
      };
    });
  }

  async getChatMemberSet(
    chatId: string,
    tx?: PrismaTransactionClient | undefined,
  ): Promise<Set<string> | null> {
    const cache = this.memberCache.get(chatId);
    if (cache !== undefined) {
      //NOTE: Implement invalidate cache
      return cache;
    }

    tx ??= this.prisma;
    const room = await tx.chat.findUnique({
      where: { id: chatId },
      select: { members: { select: { accountId: true } } },
    });

    const memberSet =
      room !== null
        ? new Set<string>(room.members.map((e) => e.accountId))
        : null;
    this.memberCache.set(chatId, memberSet);
    return memberSet;
  }

  private async prepareInspect(
    tx: PrismaTransactionClient,
    accountId: string,
  ): Promise<ChatRoomFailed | undefined> {
    const bans = await this.accounts.findActiveBansOnTransaction(tx, accountId);
    if (bans.length !== 0) {
      //TODO: return with `bans`
      return { errno: ChatErrorNumber.ERROR_ACCOUNT_BAN };
    }

    return undefined;
  }

  async insertChatMember(
    tx: PrismaTransactionClient,
    chatId: string,
    accountId: string,
    role: RoleNumber,
  ): Promise<ChatEnterRoomResult> {
    let member: ChatMemberWithRoom;
    try {
      member = await tx.chatMember.create({
        ...chatMemberWithRoom,
        data: {
          accountId,
          chatId,
          role: getRoleFromNumber(role),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code === "P2025") {
          // An operation failed because it depends on one or more records that were required but not found. {cause}
          return { errno: ChatErrorNumber.ERROR_ALREADY_MEMBER };
        }
      }
      ChatService.logUnknownError(e);
      return { errno: ChatErrorNumber.ERROR_UNKNOWN };
    }

    const cache = this.memberCache.get(chatId);
    if (cache !== undefined && cache !== null) {
      cache.add(accountId);
    }

    return {
      errno: ChatErrorNumber.SUCCESS,
      room: toChatRoomEntry(member.chat),
      member: toChatMemberEntry(member),
    };
  }

  async deleteChatMember(
    tx: PrismaTransactionClient,
    chatId: string,
    accountId: string,
  ): Promise<ChatLeaveRoomResult> {
    const cache = this.memberCache.get(chatId);
    if (cache !== undefined && cache !== null) {
      cache.delete(accountId);
    }

    let member: ChatMember;
    try {
      member = await tx.chatMember.delete({
        where: { chatId_accountId: { chatId, accountId } },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code === "P2025") {
          return { errno: ChatErrorNumber.ERROR_NO_MEMBER };
        }
      }
      ChatService.logUnknownError(e);
      return { errno: ChatErrorNumber.ERROR_UNKNOWN };
    }

    return {
      errno: ChatErrorNumber.SUCCESS,
      chatId: member.chatId,
      accountId: member.accountId,
    };
  }

  async createNewChatMessage(
    chatId: string,
    accountId: string,
    content: string,
    messageType: MessageTypeNumber,
    tx?: PrismaTransactionClient | undefined,
  ): Promise<ChatMessageEntry | null> {
    tx ??= this.prisma;
    try {
      const message = await tx.chatMessage.create({
        data: {
          chatId,
          accountId,
          content,
          messageType: getMessageTypeFromNumber(messageType),
        },
      });
      return toChatMessage(message);
    } catch (e) {
      ChatService.logUnknownError(e);
      return null;
    }
  }

  async updateLastMessageCursor(
    accountId: string,
    pair: ChatRoomChatMessagePairEntry,
  ): Promise<void> {
    void (await this.prisma.chatMember.update({
      where: { chatId_accountId: { chatId: pair.chatId, accountId } },
      data: { lastMessageId: pair.messageId },
    }));
  }

  async getChatBanned(
    chatId: string,
    accountId: string,
    category: BanCategory,
    tx?: PrismaTransactionClient | undefined,
  ): Promise<ChatBanSummaryEntry[]> {
    tx ??= this.prisma;
    const bans = await tx.chatBan.findMany({
      where: {
        chatId,
        accountId,
        category,
        OR: [
          { expireTimestamp: null },
          { expireTimestamp: { gte: new Date() } },
        ],
      },
    });

    return bans.map((e) => toBanSummaryEntry(e));
  }

  async getChatBannedForManager(chatId: string): Promise<ChatBanDetailEntry[]> {
    const bans = await this.prisma.chatBan.findMany({
      where: {
        chatId,
        OR: [
          { expireTimestamp: null },
          { expireTimestamp: { gte: new Date() } },
        ],
      },
    });

    return bans.map((e) => toBanDetailEntry(e));
  }

  async isManager(chatId: string, accountId: string): Promise<boolean> {
    const member = await this.prisma.chatMember.findUnique({
      where: { chatId_accountId: { chatId, accountId } },
      select: { role: true },
    });

    return (
      member !== null && getRoleLevel(member.role) >= getRoleLevel(Role.MANAGER)
    );
  }

  async updateLastDirectCursor(
    accountId: string,
    pair: ChatRoomChatMessagePairEntry,
  ): Promise<void> {
    void (await this.prisma.$transaction([
      this.prisma.chatDirect.updateMany({
        where: {
          OR: [
            {
              sourceAccountId: pair.chatId,
              destinationAccountId: accountId,
            },
            {
              sourceAccountId: accountId,
              destinationAccountId: pair.chatId,
            },
          ],
          isLastMessage: true,
        },
        data: { isLastMessage: false },
      }),
      this.prisma.chatDirect.updateMany({
        where: {
          OR: [
            {
              sourceAccountId: pair.chatId,
              destinationAccountId: accountId,
            },
            {
              sourceAccountId: accountId,
              destinationAccountId: pair.chatId,
            },
          ],
          id: pair.messageId,
        },
        data: { isLastMessage: true },
      }),
    ]));
  }

  async trySendDirect(
    accountId: string,
    targetAccountId: string,
    content: string,
  ): Promise<ChatMessageResult> {
    if (content === "") {
      return { errno: ChatErrorNumber.ERROR_RESTRICTED };
    }

    return this.prisma.$transaction(async (tx) => {
      const inspect = await this.prepareInspect(tx, accountId);
      if (inspect !== undefined) {
        return inspect;
      }

      if (accountId === targetAccountId) {
        //NOTE: self direct chat
        return { errno: ChatErrorNumber.ERROR_SELF };
      }
      if (!(await this.isDuplexFriend(accountId, targetAccountId, tx))) {
        return { errno: ChatErrorNumber.ERROR_NOT_FRIEND };
      }
      if (await this.isSimplexEnemy(accountId, targetAccountId, tx)) {
        return { errno: ChatErrorNumber.ERROR_ENEMY };
      }

      try {
        const message = await tx.chatDirect.create({
          data: {
            sourceAccountId: accountId,
            destinationAccountId: targetAccountId,
            content,
          },
        });
        return {
          errno: ChatErrorNumber.SUCCESS,
          message: toChatMessageFromDirect(targetAccountId, message),
        };
      } catch (e) {
        ChatService.logUnknownError(e);
        return { errno: ChatErrorNumber.ERROR_UNKNOWN };
      }
    });
  }

  async reportUser(
    accountId: string,
    targetAccountId: string,
    reason: string,
  ): Promise<ReportResult> {
    return this.prisma.$transaction(async (tx) => {
      const report = await tx.report.create({
        data: {
          accountId,
          targetAccountId,
          reason,
        },
      });
      return {
        errno: ReportErrorNumber.SUCCESS,
        reportId: report.id,
        targetAccountId: report.targetAccountId,
      };
    });
  }
}
