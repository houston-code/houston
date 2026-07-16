export function sum(items) {
  let total = 0
  for (const item of items) {
    total += item.value
  }
  return total
}
