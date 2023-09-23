import { BeforeApplicationShutdown, Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { GameWebSocket } from "./game-websocket";
import { ByteBuffer, assert } from "akasha-lib";
import { ActiveStatusNumber } from "@common/generated/types";
import {
  CLOSE_POSTED,
  HANDSHAKE_TIMED_OUT,
  SHUTTING_DOWN,
} from "@common/websocket-private-closecode";
import { ChatServer } from "../chat/chat.server";
import { FriendActiveFlags } from "@common/chat-payloads";

@Injectable()
export class GameServer implements BeforeApplicationShutdown {
  protected static readonly logger = new Logger(GameServer.name);

  private readonly temporaryClients = new Set<GameWebSocket>();
  private readonly clients = new Map<string, GameWebSocket>();
  private readonly clients_matchmake = new Map<string, GameWebSocket>();

  constructor(private readonly chatServer: ChatServer) {}

  async trackClientTemporary(client: GameWebSocket): Promise<void> {
    this.temporaryClients.add(client);
  }

  async trackClient(
    client: GameWebSocket,
    matchmaking: boolean,
  ): Promise<boolean> {
    assert(client.accountId !== undefined);

    if (
      this.clients.has(client.accountId) ||
      this.clients_matchmake.has(client.accountId)
    ) {
      return false;
    }

    assert(this.temporaryClients.delete(client));

    client.handshakeState = true;
    client.matchmaking = matchmaking;
    if (matchmaking) {
      this.clients_matchmake.set(client.accountId, client);
    } else {
      this.clients.set(client.accountId, client);
    }

    // void await LocalServer.Chats.notifyActiveStatus(client.accountId);
    this.chatServer.notifyActiveStatus(
      client.accountId,
      FriendActiveFlags.SHOW_ACTIVE_STATUS,
    );
    return true;
  }

  async untrackClient(client: GameWebSocket): Promise<void> {
    if (client.handshakeState) {
      assert(client.accountId !== undefined);
      assert(client.matchmaking !== undefined);

      if (client.matchmaking) {
        assert(this.clients_matchmake.delete(client.accountId));
      } else {
        assert(this.clients.delete(client.accountId));
      }

      // void await LocalServer.Chats.notifyActiveStatus(client.accountId);
      this.chatServer.notifyActiveStatus(
        client.accountId,
        FriendActiveFlags.SHOW_ACTIVE_STATUS,
      );
    } else {
      assert(this.temporaryClients.delete(client));
    }
  }

  @Interval(10000)
  pruneTemporaryClient() {
    const now = Date.now();
    GameServer.logger.debug(
      `Before prune connections: ${this.clients.size}, ${this.clients_matchmake.size} (T${this.temporaryClients.size})`,
    );

    for (const temporaryClient of this.temporaryClients) {
      if (temporaryClient.connectionTime + 7000 < now) {
        temporaryClient.close(HANDSHAKE_TIMED_OUT);
      }
    }

    for (const client of this.clients.values()) {
      if (client.closePosted) {
        client.close(CLOSE_POSTED);
      }
    }

    for (const client of this.clients_matchmake.values()) {
      if (client.closePosted) {
        client.close(CLOSE_POSTED);
      }
    }

    GameServer.logger.debug(
      `After prune connections: ${this.clients.size}, ${this.clients_matchmake.size} (T${this.temporaryClients.size})`,
    );
  }

  async beforeApplicationShutdown(): Promise<void> {
    GameServer.logger.log(
      `Remove remaining temporary connections: ${this.temporaryClients.size}`,
    );
    for (const temporaryClient of this.temporaryClients) {
      temporaryClient.close(HANDSHAKE_TIMED_OUT);
    }

    GameServer.logger.log(
      `Remove remaining connections: ${this.clients.size}, ${this.clients_matchmake.size}`,
    );
    for (const client of this.clients.values()) {
      assert(client.matchmaking === false);

      //TODO: More gracefully when game is in progress
      client.close(SHUTTING_DOWN);
    }
    for (const client of this.clients_matchmake.values()) {
      assert(client.matchmaking === true);

      client.close(SHUTTING_DOWN);
    }

    GameServer.logger.log(
      `Game server is ready for shutdown. ${this.clients.size}, ${this.clients_matchmake.size} (T${this.temporaryClients.size})`,
    );
  }

  uniqueAction(id: string, action: (client: GameWebSocket) => void): boolean {
    const client = this.clients.get(id);
    if (client === undefined) {
      return false;
    }

    action(client);
    return true;
  }

  unicast(id: string, buf: ByteBuffer): boolean {
    return this.uniqueAction(id, (client) => client.sendPayload(buf));
  }

  broadcast(buf: ByteBuffer, except?: GameWebSocket | undefined): void {
    for (const client of this.clients.values()) {
      if (client !== except) {
        client.sendPayload(buf);
      }
    }
  }

  uniqueActionForMatchmake(
    id: string,
    action: (client: GameWebSocket) => void,
  ): boolean {
    const client = this.clients_matchmake.get(id);
    if (client === undefined) {
      return false;
    }

    action(client);
    return true;
  }

  async getActiveStatus(id: string): Promise<ActiveStatusNumber> {
    const client = this.clients.get(id);
    if (client !== undefined) {
      return ActiveStatusNumber.GAME;
    }

    const client_matchmake = this.clients_matchmake.get(id);
    if (client_matchmake !== undefined) {
      return ActiveStatusNumber.MATCHING;
    }

    return ActiveStatusNumber.OFFLINE;
  }
}
