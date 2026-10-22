import { IsString, Matches } from 'class-validator';

export class CreateTaskDto {
  @IsString()
  @Matches(/\S/, { message: 'title must contain a non-whitespace character' })
  title!: string;
}
