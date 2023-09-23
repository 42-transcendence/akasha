import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { GameGateway } from "./game.gateway";
import { GameService } from "./game.service";
import { PrismaModule } from "@/prisma/prisma.module";
import { AccountsModule } from "@/user/accounts/accounts.module";
import { GameServer } from "./game.server";
import { GameMatchmaker } from "./game.matchmaker";
import { ChatModule } from "@/service/chat/chat.module";

@Module({
  imports: [ConfigModule, PrismaModule, AccountsModule, ChatModule],
  providers: [GameGateway, GameServer, GameMatchmaker, GameService],
  exports: [GameServer],
})
export class GameModule {}
