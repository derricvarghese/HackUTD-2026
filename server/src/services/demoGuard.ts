import { AppError } from '../errors';
/** Demo endpoints do not exist outside DEMO_MODE: answer exactly like an unknown route. */
export class NotFoundDemo extends AppError { constructor() { super(404, 'not_found', 'Not found'); } }
