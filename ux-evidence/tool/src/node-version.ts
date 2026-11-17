const MINIMUM_MAJOR = 24;

export function nodeVersionError(version: string): string | undefined {
  const major = Number.parseInt(version.replace(/^v/, ""), 10);
  return major >= MINIMUM_MAJOR ? undefined : `UX evidence needs Node ${MINIMUM_MAJOR} or newer (found ${version})`;
}
