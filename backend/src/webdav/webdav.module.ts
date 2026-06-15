import { Module } from "@nestjs/common";
import { WebDavProxyController } from "./webdav-proxy.controller";

@Module({
  controllers: [WebDavProxyController],
})
export class WebDavModule {}
