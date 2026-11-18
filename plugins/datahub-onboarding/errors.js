export class OnboardingError extends Error {
  constructor(code, details = undefined) {
    super(code);
    this.name = 'OnboardingError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function asOnboardingError(error, fallback = 'INTERNAL_ERROR') {
  // Never copy arbitrary provider error codes: even a code-shaped string can be secret.
  if (error instanceof OnboardingError) return error;
  return new OnboardingError(fallback);
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new OnboardingError('CANCELLED');
}
