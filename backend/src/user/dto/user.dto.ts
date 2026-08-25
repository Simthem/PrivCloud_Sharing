import { Expose, plainToClass } from "class-transformer";
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";

export class UserDTO {
  @Expose()
  id: string;

  @Expose()
  @Matches(/^[\p{L}\p{N}_.]*$/u, {
    message: "Username can only contain letters, numbers, dots and underscores",
  })
  @Length(3, 32)
  username: string;

  @Expose()
  @IsEmail()
  @MaxLength(254)
  email: string;

  @Expose()
  hasPassword: boolean;

  @IsString()
  @MinLength(8)
  @MaxLength(1024)
  password: string;

  @Expose()
  isAdmin: boolean;

  @Expose()
  isLdap: boolean;

  ldapDN?: string;

  @Expose()
  totpVerified: boolean;

  @Expose()
  hasEncryptionKey: boolean;

  @Expose()
  e2eAutoGenerationDisabled: boolean;

  @Expose()
  @IsOptional()
  @IsIn(["INSTANT", "DIGEST", "WEEKLY"])
  notificationMode: string;

  encryptionKeyHash?: string;

  e2eAutoGenerationDisabledAt?: Date;

  @Expose()
  createdAt: Date;

  from(partial: Partial<UserDTO>) {
    const result = plainToClass(UserDTO, partial, {
      excludeExtraneousValues: true,
    });
    result.isLdap = partial.ldapDN?.length > 0;
    result.hasEncryptionKey = !!(partial as Record<string, unknown>)
      .encryptionKeyHash;
    result.e2eAutoGenerationDisabled = !!(partial as Record<string, unknown>)
      .e2eAutoGenerationDisabledAt;
    return result;
  }

  fromList(partial: Partial<UserDTO>[]) {
    return partial.map((part) => this.from(part));
  }
}
