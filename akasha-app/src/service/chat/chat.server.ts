import { Injectable } from "@nestjs/common";
import { ChatWebSocket } from "./chat-websocket";
import { ByteBuffer, assert } from "akasha-lib";
import { ActiveStatusNumber, MessageTypeNumber } from "@common/generated/types";
import { Interval } from "@nestjs/schedule";
import { HANDSHAKE_TIMED_OUT } from "@common/websocket-private-closecode";
import { ChatMessageEntry } from "@common/chat-payloads";
import * as builder from "./chat-payload-builder";
import { ChatService } from "./chat.service";

@Injectable()
export class ChatServer {
  private readonly temporaryClients = new Set<ChatWebSocket>();
  private readonly clients = new Map<string, Set<ChatWebSocket>>();

  constructor(private readonly service: ChatService) {}

  async trackClientTemporary(client: ChatWebSocket): Promise<void> {
    this.temporaryClients.add(client);
  }

  async trackClient(client: ChatWebSocket): Promise<void> {
    assert(client.accountId !== undefined);
    assert(this.temporaryClients.delete(client));

    client.handshakeState = true;
    const id = client.accountId;
    const clientSet = this.clients.get(id);
    if (clientSet !== undefined) {
      clientSet.add(client);
    } else {
      this.clients.set(id, new Set<ChatWebSocket>([client]));
      await client.onFirstConnection();
    }
  }

  async untrackClient(client: ChatWebSocket): Promise<void> {
    if (client.handshakeState) {
      const id = client.accountId;
      const clientSet = this.clients.get(id);

      assert(clientSet !== undefined);
      assert(clientSet.delete(client));

      if (clientSet.size === 0) {
        await client.onLastDisconnect();
        this.clients.delete(id);
      }
    } else {
      assert(this.temporaryClients.delete(client));
    }
  }

  @Interval(10000)
  pruneTemporaryClient() {
    const now = Date.now();
    for (const temporaryClient of this.temporaryClients) {
      if (temporaryClient.connectionTime + 7000 < now) {
        temporaryClient.close(HANDSHAKE_TIMED_OUT);
      }
    }
  }

  sharedAction(
    id: string,
    action: (client: ChatWebSocket) => void,
    except?: ChatWebSocket | undefined,
  ): boolean {
    const clientSet = this.clients.get(id);
    if (clientSet === undefined) {
      return false;
    }

    for (const client of clientSet) {
      if (client !== except) {
        action(client);
      }
    }
    return true;
  }

  unicast(
    id: string,
    buf: ByteBuffer,
    except?: ChatWebSocket | undefined,
  ): boolean {
    return this.sharedAction(id, (client) => client.sendPayload(buf), except);
  }

  broadcast(buf: ByteBuffer, except?: ChatWebSocket | undefined): void {
    for (const [, clientSet] of this.clients) {
      for (const client of clientSet) {
        if (client !== except) {
          client.sendPayload(buf);
        }
      }
    }
  }

  async getActiveStatus(id: string): Promise<ActiveStatusNumber> {
    const clientSet = this.clients.get(id);
    if (clientSet === undefined) {
      return ActiveStatusNumber.OFFLINE;
    }

    if (
      [...clientSet].every(
        (e) => e.socketActiveStatus === ActiveStatusNumber.IDLE,
      )
    ) {
      return ActiveStatusNumber.IDLE;
    }

    return ActiveStatusNumber.ONLINE;
  }

  notifyActiveStatus(
    accountId: string,
    activeFlags: number,
    invisible: boolean = false,
  ) {
    const buf = builder.makeUpdateFriendActiveStatus(accountId);
    void this.unicast(accountId, buf);
    if (!invisible) {
      void this.multicastToFriend(accountId, buf, activeFlags);
    }
  }

  async multicastToFriend(
    id: string,
    buf: ByteBuffer,
    activeFlags?: number | undefined,
  ): Promise<number> {
    let counter = 0;
    const duplexFriends = await this.service.getDuplexFriends(id);
    for (const friend of duplexFriends) {
      if (
        activeFlags !== undefined &&
        (friend.activeFlags & activeFlags) !== activeFlags
      ) {
        continue;
      }

      if (this.unicast(friend.friendAccountId, buf, undefined)) {
        counter++;
      }
    }
    return counter;
  }

  async sendNotice(
    chatId: string,
    accountId: string,
    content: string,
  ): Promise<ChatMessageEntry | null> {
    const message = await this.service.createNewChatMessage(
      chatId,
      accountId,
      content,
      MessageTypeNumber.NOTICE,
    );
    if (message !== null) {
      void this.multicastToRoom(
        chatId,
        builder.makeChatMessagePayload(message),
      );
    }
    return message;
  }

  async multicastToRoom(
    chatId: string,
    buf: ByteBuffer,
    exceptAccountId?: string | undefined,
  ): Promise<number> {
    let counter = 0;
    const memberSet = await this.service.getChatMemberSet(chatId);
    if (memberSet !== null) {
      for (const memberAccountId of memberSet) {
        if (memberAccountId === exceptAccountId) {
          continue;
        }

        if (this.unicast(memberAccountId, buf, undefined)) {
          counter++;
        }
      }
    }
    return counter;
  }
}
