import { IsString, Matches } from 'class-validator';

export class CreateUserDto {
  @IsString()
  @Matches(/\S/, { message: 'name must contain a non-whitespace character' })
  name!: string;
}
