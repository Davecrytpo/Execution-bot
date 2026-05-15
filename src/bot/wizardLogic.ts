export function isValidPositiveSolAmount(input: string) {
  const value = Number(input.trim());
  return Number.isFinite(value) && value > 0;
}
