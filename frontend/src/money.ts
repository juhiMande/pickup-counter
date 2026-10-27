// Prices are integers in paise; only format at the edge.
export function rupees(paise: number): string {
  const whole = Math.floor(paise / 100);
  const rest = paise % 100;
  return `₹${whole.toLocaleString('en-IN')}${rest ? '.' + String(rest).padStart(2, '0') : ''}`;
}
