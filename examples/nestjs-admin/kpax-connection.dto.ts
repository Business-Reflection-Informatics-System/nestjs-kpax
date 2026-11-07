import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

const url = { require_tld: false, protocols: ['http', 'https'] };

export class CreateKpaxConnectionDto {
  @IsString() @IsNotEmpty() @MaxLength(100) name!: string;
  @IsUrl(url) @MaxLength(255) host!: string;
  @IsString() @IsNotEmpty() @MaxLength(255) clientId!: string;
  /** Write-only: stored encrypted, never returned. */
  @IsString() @IsNotEmpty() clientSecret!: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  scopes?: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateKpaxConnectionDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) name?: string;
  @IsOptional() @IsUrl(url) @MaxLength(255) host?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(255) clientId?: string;
  /** Blank keeps the stored secret. */
  @IsOptional() @IsString() clientSecret?: string;
  /** Empty array resets to the module's default scopes. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  scopes?: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class TestKpaxConnectionDto {
  @IsUrl(url) host!: string;
  @IsString() @IsNotEmpty() clientId!: string;
  @IsString() @IsNotEmpty() clientSecret!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) scopes?: string[];
}
