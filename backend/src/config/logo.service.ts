import { Injectable } from "@nestjs/common";
import * as fs from "fs";
import * as sharp from "sharp";

const IMAGES_PATH = "../frontend/public/img";

@Injectable()
export class LogoService {
  async create(file: Buffer) {
    const resized = await sharp(file).resize(512).webp({ quality: 85 }).toBuffer();
    fs.writeFileSync(`${IMAGES_PATH}/logo.webp`, resized, "binary");
    this.createHomepageLogo(file);
    this.createFavicon(file);
    this.createPWAIcons(file);
  }

  async createHomepageLogo(file: Buffer) {
    const resized = await sharp(file)
      .resize(200, 200, { fit: "cover" })
      .webp({ quality: 85 })
      .toBuffer();
    fs.promises.writeFile(
      `${IMAGES_PATH}/logo-200x200.webp`,
      resized,
      "binary",
    );
  }

  async createFavicon(file: Buffer) {
    const resized = await sharp(file)
      .resize(16, 16, { fit: "cover" })
      .png()
      .toBuffer();
    fs.promises.writeFile(`${IMAGES_PATH}/favicon.ico`, resized, "binary");
  }

  async createPWAIcons(file: Buffer) {
    const sizes = [48, 72, 96, 128, 144, 152, 192, 384, 512];

    for (const size of sizes) {
      const resized = await sharp(file)
        .resize(size, size, { fit: "cover" })
        .png()
        .toBuffer();
      fs.promises.writeFile(
        `${IMAGES_PATH}/icons/icon-${size}x${size}.png`,
        resized,
        "binary",
      );
    }
  }
}
