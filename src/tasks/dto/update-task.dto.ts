import {
  IsBoolean,
  IsInt,
  IsString,
  Matches,
  Min,
  ValidateIf,
} from 'class-validator';

export class UpdateTaskDto {
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/\S/, { message: 'title must contain a non-whitespace character' })
  title?: string;

  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsBoolean()
  completed?: boolean;

  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  assigneeId?: number;
}
