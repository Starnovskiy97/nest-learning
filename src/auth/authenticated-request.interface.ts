import type { Request } from 'express';
import type { User } from '../users/user.interface';

export interface AuthenticatedRequest extends Request {
  user: User;
}
