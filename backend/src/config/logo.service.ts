import { Injectable } from "@nestjs/common";
import * as fs from "fs";
import sharp from "sharp";

const IMAGES_PATH = "../frontend/public/img";
const TRANSPARENT_BACKGROUND = { r: 0, g: 0, b: 0, alpha: 0 };
const SQUARE_RESIZE = {
  fit: "contain" as const,
  background: TRANSPARENT_BACKGROUND,
};

@Injectable()
export class LogoService {
  async create(file: Buffer) {
    await fs.promises.mkdir(`${IMAGES_PATH}/icons`, { recursive: true });
    await Promise.all([
      this.createLogoFiles(file),
      this.createFavicon(file),
      this.createPWAIcons(file),
    ]);
  }

  async createLogoFiles(file: Buffer) {
    await Promise.all([
      sharp(file)
        .resize(512, 512, SQUARE_RESIZE)
        .png()
        .toFile(`${IMAGES_PATH}/logo.png`),
      sharp(file)
        .resize(512, 512, SQUARE_RESIZE)
        .webp({ quality: 85 })
        .toFile(`${IMAGES_PATH}/logo.webp`),
      ...[72, 144, 200].map((size) =>
        sharp(file)
          .resize(size, size, SQUARE_RESIZE)
          .webp({ quality: 85 })
          .toFile(`${IMAGES_PATH}/logo-${size}x${size}.webp`),
      ),
    ]);
  }

  async createFavicon(file: Buffer) {
    const resized = await sharp(file)
      .resize(32, 32, SQUARE_RESIZE)
      .png()
      .toBuffer();
    await fs.promises.writeFile(`${IMAGES_PATH}/favicon.ico`, resized);
  }

  async createPWAIcons(file: Buffer) {
    const sizes = [48, 72, 96, 128, 144, 152, 192, 384, 512];

    for (const size of sizes) {
      const resized = await sharp(file)
        .resize(size, size, SQUARE_RESIZE)
        .png()
        .toBuffer();
      await fs.promises.writeFile(
        `${IMAGES_PATH}/icons/icon-${size}x${size}.png`,
        resized,
      );
    }
  }
}
