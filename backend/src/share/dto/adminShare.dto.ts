import { Expose, plainToClass, Type } from "class-transformer";
import { PublicUserDTO } from "src/user/dto/publicUser.dto";

/** Data-minimised administration view without public links or content names. */
export class AdminShareDTO {
  @Expose()
  reference: string;

  @Expose()
  @Type(() => PublicUserDTO)
  creator?: PublicUserDTO;

  @Expose()
  views: number;

  @Expose()
  createdAt: Date;

  @Expose()
  expiration: Date;

  @Expose()
  size: number;

  @Expose()
  fileCount: number;

  @Expose()
  isE2EEncrypted: boolean;

  @Expose()
  status: "READY" | "UPLOADING";

  from(partial: Partial<AdminShareDTO>) {
    return plainToClass(AdminShareDTO, partial, {
      excludeExtraneousValues: true,
    });
  }

  fromList(partial: Partial<AdminShareDTO>[]) {
    return partial.map((part) => this.from(part));
  }
}
