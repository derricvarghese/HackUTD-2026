import { ApiError } from '../api/client';
import { conflictMessage, errorMessage } from './data';

describe('error messages', () => {
  it('explains a claim conflict with the current assignee', () => {
    const e = new ApiError(409, 'conflict', 'Case already claimed by another responder', { assignment: { responder_name: 'Bob Chen' } });
    expect(conflictMessage(e)).toBe('Already claimed by Bob Chen. The queue has been refreshed.');
  });
  it('explains other conflicts and ignores non-conflicts', () => {
    expect(conflictMessage(new ApiError(409, 'conflict', 'Cannot go from resolved to en_route'))).toBe('Cannot go from resolved to en_route. The case changed; refreshed.');
    expect(conflictMessage(new ApiError(403, 'forbidden', 'no'))).toBeNull();
    expect(conflictMessage(new Error('x'))).toBeNull();
  });
  it('turns errors into toast text', () => {
    expect(errorMessage(new ApiError(0, 'network', 'Cannot reach the Beacon server'))).toBe('Cannot reach the Beacon server');
    expect(errorMessage(new ApiError(400, 'validation_failed', 'bad'))).toBe('bad');
    expect(errorMessage('weird')).toBe('Something went wrong');
  });
});
