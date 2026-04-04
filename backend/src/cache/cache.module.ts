import { Logger, Module } from "@nestjs/common";
import { CacheModule } from "@nestjs/cache-manager";
import { CacheableMemory } from "cacheable";
import KeyvRedis from "@keyv/redis";
import { Keyv } from "keyv";
import { ConfigModule } from "src/config/config.module";
import { ConfigService } from "src/config/config.service";

const logger = new Logger("AppCacheModule");

@Module({
  imports: [
    ConfigModule,
    CacheModule.registerAsync({
      isGlobal: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const useRedis = configService.get("cache.redis-enabled");
        // Config stores TTL in seconds; cache-manager v6 / cacheable
        // / keyv all expect milliseconds.
        const ttl = configService.get("cache.ttl") * 1000;
        const max = configService.get("cache.maxItems");

        const memoryStore = new Keyv({
          store: new CacheableMemory({ ttl, lruSize: max }),
        });

        const config = {
          ttl,
          max,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stores: [memoryStore] as any[],
          // Secondary store (Redis) writes are fire-and-forget so a
          // slow / unreachable Redis never blocks cache operations.
          nonBlocking: true,
        };

        if (useRedis) {
          const redisUrl = configService.get("cache.redis-url");

          try {
            // If the value starts with '/' it is a Unix socket path;
            // @redis/client cannot parse redis+unix:// URLs so we
            // pass the socket option object directly.
            const keyvRedis = redisUrl.startsWith("/")
              ? new KeyvRedis({ socket: { path: redisUrl } })
              : new KeyvRedis(redisUrl);
            // Attach error handler on the underlying RedisClient
            // to prevent unhandled 'error' event crashing the process.
            keyvRedis.client.on("error", (err: Error) => {
              logger.warn(`Redis client error (non-fatal): ${err.message}`);
            });
            const redisStore = new Keyv({ store: keyvRedis });
            redisStore.on("error", (err: Error) => {
              logger.warn(`Redis Keyv error (non-fatal): ${err.message}`);
            });
            config.stores = [memoryStore, redisStore];
            logger.log(`Redis cache store configured: ${redisUrl}`);
          } catch (err) {
            logger.warn(
              `Failed to create Redis store, falling back to memory-only: ${err}`,
            );
          }
        }

        return config;
      },
    }),
  ],
  exports: [CacheModule],
})
export class AppCacheModule {}
