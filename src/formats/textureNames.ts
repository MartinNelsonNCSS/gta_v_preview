/** Texture names: letters, digits and `_ - .`, as the game and tools expect. */
export function textureNameProblem(name: string): string | undefined {
  if (!name) return 'Enter a name.';
  if (name.length > 64) return 'Names can be at most 64 characters.';
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return 'Use only letters, digits, "_", "-" and ".".';
  return undefined;
}
