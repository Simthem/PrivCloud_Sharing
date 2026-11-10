import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from "class-validator";

class RecipientKeyEnvelopeDTO {
  @IsUUID()
  recipientId: string;

  @IsUUID()
  userId: string;

  @IsString()
  @MaxLength(50000)
  encryptedKeyEnvelope: string;
}

export class RecipientKeyEnvelopesDTO {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RecipientKeyEnvelopeDTO)
  recipients: RecipientKeyEnvelopeDTO[];
}
