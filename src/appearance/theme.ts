export function invertHex(hex: string): string {
  return `#${(0xffffff ^ parseInt(hex.slice(1), 16)).toString(16).padStart(6, '0')}`;
}
