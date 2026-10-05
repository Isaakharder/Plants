const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

export const formatInteger = (n: number) => integer.format(n)
export const formatArea = (n: number) => decimal.format(n)

/** Parses user input like "31,114" or "31114.5". Returns NaN when invalid. */
export function parseNumberInput(value: string): number {
  const cleaned = value.replace(/[,\s]/g, '')
  if (cleaned === '' || !/^\d*\.?\d+$/.test(cleaned)) return Number.NaN
  return Number(cleaned)
}
