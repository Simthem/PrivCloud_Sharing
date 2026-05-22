import { Expose, plainToClass } from "class-transformer";
import { IsEmail, IsIn, IsOptional, Length, Matches, MinLength } from "class-validator";

export class UserSubscriptionDTO {
  plan: string;
  status: string;
  currentPeriodEnd: Date | null;
}

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
  email: string;

  @Expose()
  hasPassword: boolean;

  @MinLength(8)
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
  @IsOptional()
  @IsIn(["INSTANT", "DIGEST", "WEEKLY"])
  notificationMode: string;

  encryptionKeyHash?: string;

  @Expose()
  createdAt: Date;

  // Populated by controller when listing users (admin)
  plan?: string;
  planStatus?: string;
  planRenewDate?: Date | null;

  from(partial: Partial<UserDTO>) {
    const result = plainToClass(UserDTO, partial, {
      excludeExtraneousValues: true,
    });
    result.isLdap = partial.ldapDN?.length > 0;
    result.hasEncryptionKey = !!(partial as Record<string, unknown>).encryptionKeyHash;
    return result;
  }

  fromList(partial: Partial<UserDTO>[]) {
    return partial.map((part) => this.from(part));
  }
}
